// =============================================================================
// Renewal Risk Scoring Service
//
// Pure function — no I/O, no side effects. The caller is responsible for
// fetching the required signals from the database.
//
// Scoring weights (sum to 100):
//   Days to expiry      40 pts  — proximity to lease end is the strongest signal
//   Payment delinquency 25 pts  — financial stress predicts non-renewal
//   No renewal offer    20 pts  — residents who haven't been approached are at risk
//   Rent vs. market     15 pts  — if market rent >> current rent, resident may leave
//
// Tier thresholds:
//   high   ≥ 65   — immediate intervention recommended
//   medium 40–64  — worth contacting proactively
//   low    < 40   — monitoring only; not included in flagged count
// =============================================================================

// ---------------------------------------------------------------------------
// Types — exported so route handlers and DB layer can share them
// ---------------------------------------------------------------------------

export type RiskTier = 'high' | 'medium' | 'low';

export interface RiskScoreInput {
  /** True when lease_type = 'month_to_month'. */
  isMonthToMonth: boolean;
  /**
   * Calendar days from asOfDate to lease_end_date.
   * Ignored for scoring when isMonthToMonth is true; still passed through
   * to the signals output for display purposes.
   */
  daysToExpiry: number;
  /** Rent payments of type 'rent' missed in the last 6 calendar months. */
  missedRentPaymentsLast6Mo: number;
  /** True when the resident has a 'pending' or 'accepted' renewal offer. */
  hasActiveRenewalOffer: boolean;
  /** Resident's current monthly_rent from the active lease. */
  currentRent: number;
  /**
   * Most recent market_rent from unit_pricing; null when no pricing row exists.
   * A null value means the rent-growth signal contributes 0 points.
   */
  marketRent: number | null;
}

export interface RiskSignals {
  /** Actual days to expiry passed in (for display; MTM may be 0 or negative). */
  daysToExpiryDays: number;
  paymentHistoryDelinquent: boolean;
  noRenewalOfferYet: boolean;
  rentGrowthAboveMarket: boolean;
}

export interface RiskScoreResult {
  /** 0–100 composite score (sum of weighted signal points). */
  riskScore: number;
  riskTier: RiskTier;
  signals: RiskSignals;
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const DAYS_MAX = 40;
const PAYMENT_MAX = 25;
const OFFER_MAX = 20;
const RENT_MAX = 15;
// DAYS_MAX + PAYMENT_MAX + OFFER_MAX + RENT_MAX === 100

const HIGH_THRESHOLD = 65;
const MEDIUM_THRESHOLD = 40;

/**
 * Fixed days-component score for month-to-month leases.
 * MTM residents can leave at any time (high-ish urgency) but are not as
 * immediately at risk as a fixed-term lease expiring in < 30 days.
 * 20 pts places them in a similar band to a lease with ~61–90 days left.
 */
const MTM_DAYS_SCORE = 20;

// ---------------------------------------------------------------------------
// Signal sub-scorers (private)
// ---------------------------------------------------------------------------

/**
 * Returns 0–40 points.
 * Month-to-month leases receive a fixed moderate score; fixed-term leases
 * are scored on a stepped scale based on urgency.
 */
function scoreDaysToExpiry(isMonthToMonth: boolean, days: number): number {
  if (isMonthToMonth) return MTM_DAYS_SCORE;
  if (days <= 30) return DAYS_MAX;       // critically urgent
  if (days <= 60) return 30;             // urgent
  if (days <= 90) return 20;             // worth watching
  if (days <= 120) return 10;            // mild signal
  return 0;
}

/**
 * Returns 0–25 points.
 * Scaled by severity: a single missed payment is a weak signal (5 pts);
 * three or more indicates a pattern (full 25 pts).
 */
function scorePaymentHistory(missedPayments: number): number {
  if (missedPayments >= 3) return PAYMENT_MAX;
  if (missedPayments === 2) return 15;
  if (missedPayments === 1) return 5;
  return 0;
}

/** Returns 0 or 20 points. Full weight when no offer has been sent. */
function scoreRenewalOffer(hasActiveOffer: boolean): number {
  return hasActiveOffer ? 0 : OFFER_MAX;
}

/**
 * Returns 0–15 points based on how far market rent exceeds current rent.
 * Returns 0 when market rent data is unavailable or market ≤ current.
 */
function scoreRentGrowth(currentRent: number, marketRent: number | null): number {
  if (marketRent === null || marketRent <= currentRent) return 0;
  const growthPct = (marketRent - currentRent) / currentRent;
  if (growthPct > 0.10) return RENT_MAX;   // > 10% above market
  if (growthPct > 0.05) return 8;          // 5–10% above market
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Derives the risk tier from a 0–100 score. Exported for reuse in routes. */
export function getRiskTier(score: number): RiskTier {
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Calculates a 0–100 renewal risk score and tier from pre-fetched signals.
 *
 * @example
 * const result = calculateRiskScore({
 *   isMonthToMonth: false,
 *   daysToExpiry: 45,
 *   missedRentPaymentsLast6Mo: 0,
 *   hasActiveRenewalOffer: false,
 *   currentRent: 1400,
 *   marketRent: 1600,
 * });
 * // → { riskScore: 65, riskTier: 'high', signals: { ... } }
 */
export function calculateRiskScore(input: RiskScoreInput): RiskScoreResult {
  const daysPoints = scoreDaysToExpiry(input.isMonthToMonth, input.daysToExpiry);
  const paymentPoints = scorePaymentHistory(input.missedRentPaymentsLast6Mo);
  const offerPoints = scoreRenewalOffer(input.hasActiveRenewalOffer);
  const rentPoints = scoreRentGrowth(input.currentRent, input.marketRent);

  // Weights sum to 100, so the total is already on a 0–100 scale.
  const riskScore = daysPoints + paymentPoints + offerPoints + rentPoints;

  return {
    riskScore,
    riskTier: getRiskTier(riskScore),
    signals: {
      daysToExpiryDays: input.daysToExpiry,
      paymentHistoryDelinquent: input.missedRentPaymentsLast6Mo > 0,
      noRenewalOfferYet: !input.hasActiveRenewalOffer,
      rentGrowthAboveMarket: rentPoints > 0,
    },
  };
}
