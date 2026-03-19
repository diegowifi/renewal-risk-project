import pool from '../db';
import { deliverWebhook } from './webhookService';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How often the worker polls for retryable webhooks. */
const POLL_INTERVAL_MS = 5_000;

/** Max rows processed per poll cycle — prevents bursts from overwhelming the RMS. */
const BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Core poll loop
// ---------------------------------------------------------------------------

/**
 * Finds all pending webhooks whose retry delay has elapsed and fires a
 * delivery attempt for each one.  Runs entirely in the background; errors
 * are logged but never bubble up to crash the process.
 */
async function processRetries(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id
       FROM webhook_delivery_state
      WHERE status        = 'pending'
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= NOW()
      LIMIT $1`,
    [BATCH_SIZE],
  );

  if (rows.length === 0) return;

  console.log(`Retry worker: dispatching ${rows.length} webhook(s)`);

  // Run all retries concurrently; failures are logged per-webhook.
  await Promise.allSettled(
    rows.map((r) =>
      deliverWebhook(r.id).catch((err) => {
        console.error(`Retry delivery error for webhook ${r.id}:`, err);
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the background retry worker.
 * Call once after the database connection is verified.
 * Returns the interval handle so callers can stop it gracefully on shutdown.
 */
export function startRetryWorker(): ReturnType<typeof setInterval> {
  console.log(
    `✓ Webhook retry worker started (poll interval: ${POLL_INTERVAL_MS}ms, batch: ${BATCH_SIZE})`,
  );

  return setInterval(() => {
    processRetries().catch((err) => {
      console.error('Retry worker poll error:', err);
    });
  }, POLL_INTERVAL_MS);
}
