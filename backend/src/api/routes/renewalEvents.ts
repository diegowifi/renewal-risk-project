import { Request, Response, Router } from 'express';
import pool from '../../db';
import { AppError } from '../../errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { createAndDeliverEvent, RenewalEventData } from '../../webhooks/webhookService';

// mergeParams lets handlers read :propertyId and :residentId from parent routes.
const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`${name} must be a valid UUID`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// DB row type for latest risk score
// ---------------------------------------------------------------------------

interface LatestScoreRow {
  risk_score: number;
  risk_tier: string;
  days_to_expiry: number | null;
  payment_delinquent: boolean;
  no_renewal_offer: boolean;
  rent_growth_above_market: boolean;
}

// ---------------------------------------------------------------------------
// POST /api/v1/properties/:propertyId/residents/:residentId/renewal-event
// ---------------------------------------------------------------------------

/**
 * Triggers a renewal event for a specific resident.
 *
 * Looks up the resident's latest risk score and delivers a webhook payload to
 * the configured RMS endpoint.  The event_id is deterministic
 * (`evt-{residentId}-{YYYY-MM-DD}`) so that repeated clicks on the same day
 * return the existing delivery record without creating a duplicate.
 *
 * Returns HTTP 202 immediately; the webhook is delivered asynchronously.
 */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const propertyId = requireUuid(req.params.propertyId, 'propertyId');
    const residentId = requireUuid(req.params.residentId, 'residentId');

    // Verify the resident belongs to this property and is active.
    const { rowCount } = await pool.query(
      `SELECT 1 FROM residents WHERE id = $1 AND property_id = $2 AND status = 'active'`,
      [residentId, propertyId],
    );
    if (!rowCount) {
      throw AppError.notFound(
        `Active resident ${residentId} not found in property ${propertyId}`,
      );
    }

    // Fetch the most recent risk score — it drives the webhook payload.
    const { rows } = await pool.query<LatestScoreRow>(
      `SELECT risk_score, risk_tier, days_to_expiry,
              payment_delinquent, no_renewal_offer, rent_growth_above_market
         FROM renewal_risk_scores
        WHERE property_id = $1
          AND resident_id = $2
        ORDER BY calculated_at DESC
        LIMIT 1`,
      [propertyId, residentId],
    );

    if (!rows.length) {
      throw AppError.notFound(
        `No risk score found for resident ${residentId}. Run /calculate first.`,
      );
    }

    const score = rows[0];

    const data: RenewalEventData = {
      riskScore:    score.risk_score,
      riskTier:     score.risk_tier,
      daysToExpiry: score.days_to_expiry ?? 0,
      signals: {
        daysToExpiryDays:         score.days_to_expiry ?? 0,
        paymentHistoryDelinquent: score.payment_delinquent,
        noRenewalOfferYet:        score.no_renewal_offer,
        rentGrowthAboveMarket:    score.rent_growth_above_market,
      },
    };

    // Deterministic event_id for same-day idempotency.
    const today   = new Date().toISOString().slice(0, 10);
    const eventId = `evt-${residentId}-${today}`;

    const result = await createAndDeliverEvent(propertyId, residentId, eventId, data);

    res.status(202).json({
      eventId:   result.eventId,
      webhookId: result.webhookId,
      status:    'pending',
      message:   'Renewal event queued for delivery',
    });
  }),
);

export default router;
