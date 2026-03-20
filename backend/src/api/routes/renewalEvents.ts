import { Request, Response, Router } from 'express';
import pool from '../../db';
import { AppError } from '../../errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireUuid } from '../validation';
import { createAndDeliverEvent, RenewalEventData } from '../../webhooks/webhookService';

// mergeParams lets handlers read :propertyId and :residentId from parent routes.
const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// DB row type for resident + latest risk score (single-query shape)
// ---------------------------------------------------------------------------

interface ResidentScoreRow {
  risk_score: number | null;
  risk_tier: string | null;
  days_to_expiry: number | null;
  payment_delinquent: boolean | null;
  no_renewal_offer: boolean | null;
  rent_growth_above_market: boolean | null;
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

    // Single query: verify the resident is active AND fetch their latest risk score.
    // Returns one row if the resident exists (rrs columns are NULL when no score yet),
    // or no rows if the resident is not found / not active.
    const { rows } = await pool.query<ResidentScoreRow>(
      `SELECT rrs.risk_score, rrs.risk_tier, rrs.days_to_expiry,
              rrs.payment_delinquent, rrs.no_renewal_offer, rrs.rent_growth_above_market
         FROM residents r
         LEFT JOIN LATERAL (
           SELECT risk_score, risk_tier, days_to_expiry,
                  payment_delinquent, no_renewal_offer, rent_growth_above_market
             FROM renewal_risk_scores
            WHERE property_id = $1
              AND resident_id = $2
            ORDER BY calculated_at DESC
            LIMIT 1
         ) rrs ON true
        WHERE r.id = $2
          AND r.property_id = $1
          AND r.status = 'active'`,
      [propertyId, residentId],
    );

    if (!rows.length) {
      throw AppError.notFound(
        `Active resident ${residentId} not found in property ${propertyId}`,
      );
    }

    const score = rows[0];

    if (score.risk_score === null) {
      throw AppError.notFound(
        `No risk score found for resident ${residentId}. Run /calculate first.`,
      );
    }

    const data: RenewalEventData = {
      riskScore:    score.risk_score!,
      riskTier:     score.risk_tier!,
      daysToExpiry: score.days_to_expiry ?? 0,
      signals: {
        daysToExpiryDays:         score.days_to_expiry ?? 0,
        paymentHistoryDelinquent: score.payment_delinquent!,
        noRenewalOfferYet:        score.no_renewal_offer!,
        rentGrowthAboveMarket:    score.rent_growth_above_market!,
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
