import crypto from 'crypto';
import pool from '../db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum delivery attempts before a webhook is moved to the DLQ. */
const MAX_ATTEMPTS = 5;

/**
 * Exponential-backoff delays between attempts (milliseconds).
 * Index 0 = delay before attempt 2, index 4 = delay before attempt 5.
 * After attempt 5 the webhook is moved to the DLQ — no further delays needed.
 */
const BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** HTTP timeout for a single delivery attempt. */
const HTTP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenewalEventData {
  riskScore: number;
  riskTier: string;
  daysToExpiry: number;
  signals: {
    daysToExpiryDays: number;
    paymentHistoryDelinquent: boolean;
    noRenewalOfferYet: boolean;
    rentGrowthAboveMarket: boolean;
  };
}

interface WebhookRow {
  id: string;
  event_id: string;
  property_id: string;
  resident_id: string;
  payload: object;
  status: string;
  attempt_count: number;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Signs the serialised payload with HMAC-SHA256.
 * The RMS should verify: HMAC-SHA256(secret, body) === X-Webhook-Signature header.
 */
function sign(payloadStr: string): string {
  const secret = process.env.WEBHOOK_SECRET ?? '';
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
}

// ---------------------------------------------------------------------------
// Core delivery
// ---------------------------------------------------------------------------

/**
 * Delivers a single webhook by ID.
 *
 * Flow:
 *   1. Read the webhook row (skip if already delivered/dlq).
 *   2. Attempt HTTP POST to RMS_ENDPOINT with HMAC signature and idempotency header.
 *   3. On success → set status = 'delivered'.
 *      On failure, attempts < MAX_ATTEMPTS → set next_retry_at with exponential backoff.
 *      On failure, attempts = MAX_ATTEMPTS → set status = 'dlq' + insert DLQ row atomically.
 *
 * The HTTP call is intentionally made OUTSIDE a database transaction to avoid
 * holding a connection open for up to HTTP_TIMEOUT_MS.
 */
export async function deliverWebhook(webhookId: string): Promise<void> {
  // --- Phase 1: read row (non-transactional, best-effort) ---
  const { rows } = await pool.query<WebhookRow>(
    `SELECT id, event_id, property_id, resident_id, payload, status, attempt_count
       FROM webhook_delivery_state
      WHERE id = $1`,
    [webhookId],
  );

  if (!rows.length) return;

  const webhook = rows[0];
  if (webhook.status === 'delivered' || webhook.status === 'dlq') return;

  const attemptNumber = webhook.attempt_count + 1;
  const payloadStr    = JSON.stringify(webhook.payload);
  const signature     = sign(payloadStr);
  const endpoint      = process.env.RMS_ENDPOINT ?? '';

  // --- Phase 2: HTTP call (outside transaction) ---
  let success    = false;
  let rmsResponse: string | null = null;

  try {
    const response = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Webhook-Signature':   signature,
        'X-Event-Id':            webhook.event_id,
      },
      body:   payloadStr,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    rmsResponse = await response.text().catch(() => '');
    success     = response.ok;

    if (!success) {
      console.warn(
        `Webhook ${webhookId} attempt ${attemptNumber}: RMS returned ${response.status}`,
      );
    }
  } catch (err) {
    rmsResponse = err instanceof Error ? err.message : String(err);
    console.warn(`Webhook ${webhookId} attempt ${attemptNumber}: ${rmsResponse}`);
  }

  // --- Phase 3: persist result (transactional) ---
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (success) {
      await client.query(
        `UPDATE webhook_delivery_state
            SET status           = 'delivered',
                attempt_count    = $1,
                last_attempt_at  = NOW(),
                next_retry_at    = NULL,
                rms_response     = $2,
                updated_at       = NOW()
          WHERE id = $3`,
        [attemptNumber, rmsResponse, webhookId],
      );
    } else if (attemptNumber >= MAX_ATTEMPTS) {
      // Promote to DLQ — both updates are in the same transaction (atomic).
      await client.query(
        `UPDATE webhook_delivery_state
            SET status           = 'dlq',
                attempt_count    = $1,
                last_attempt_at  = NOW(),
                next_retry_at    = NULL,
                rms_response     = $2,
                updated_at       = NOW()
          WHERE id = $3`,
        [attemptNumber, rmsResponse, webhookId],
      );
      await client.query(
        `INSERT INTO webhook_dead_letter_queue (webhook_delivery_state_id, reason)
              VALUES ($1, 'max_retries_exceeded')
         ON CONFLICT (webhook_delivery_state_id) DO NOTHING`,
        [webhookId],
      );
      console.error(`Webhook ${webhookId} moved to DLQ after ${attemptNumber} attempts`);
    } else {
      // Schedule next retry with exponential backoff.
      // BACKOFF_DELAYS_MS is 0-indexed: attempt 1 failure → delay[0]=1s, etc.
      const delayMs   = BACKOFF_DELAYS_MS[attemptNumber - 1] ?? BACKOFF_DELAYS_MS.at(-1)!;
      const nextRetry = new Date(Date.now() + delayMs).toISOString();

      await client.query(
        `UPDATE webhook_delivery_state
            SET attempt_count    = $1,
                last_attempt_at  = NOW(),
                next_retry_at    = $2,
                rms_response     = $3,
                updated_at       = NOW()
          WHERE id = $4`,
        [attemptNumber, nextRetry, rmsResponse, webhookId],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Event creation + immediate delivery
// ---------------------------------------------------------------------------

/**
 * Persists a renewal event to the DB and fires the first delivery attempt
 * asynchronously (fire-and-forget) so the HTTP response returns immediately.
 *
 * Idempotency: `event_id` is a deterministic key (`evt-{residentId}-{YYYY-MM-DD}`).
 * A second call with the same key hits the ON CONFLICT clause and returns the
 * existing record without creating a duplicate.
 */
export async function createAndDeliverEvent(
  propertyId: string,
  residentId: string,
  eventId: string,
  data: RenewalEventData,
): Promise<{ webhookId: string; eventId: string }> {
  const payload = {
    event:      'renewal.risk_flagged',
    eventId,
    timestamp:  new Date().toISOString(),
    propertyId,
    residentId,
    data,
  };

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webhook_delivery_state
       (event_id, property_id, resident_id, event_type, payload)
     VALUES ($1, $2, $3, 'renewal.risk_flagged', $4)
     ON CONFLICT (event_id) DO UPDATE
       SET updated_at = NOW()
     RETURNING id`,
    [eventId, propertyId, residentId, JSON.stringify(payload)],
  );

  const webhookId = rows[0].id;

  // Attempt immediate delivery without blocking the HTTP response.
  setImmediate(() => {
    deliverWebhook(webhookId).catch((err) => {
      console.error(`Immediate webhook delivery error for ${webhookId}:`, err);
    });
  });

  return { webhookId, eventId };
}
