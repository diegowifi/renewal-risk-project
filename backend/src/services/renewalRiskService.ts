import pool from '../db';
import { AppError } from '../errors';
import { calculateRiskScore, RiskSignals, RiskTier } from './riskScoringService';

// ---------------------------------------------------------------------------
// Row types returned by PostgreSQL queries
// ---------------------------------------------------------------------------

/** One row per active resident, with all signals pre-joined. */
interface ResidentRow {
  resident_id: string;
  name: string;
  unit_id: string;
  unit_number: string;
  lease_id: string;
  lease_type: string;
  monthly_rent: string;        // pg returns NUMERIC as string
  market_rent: string | null;  // pg returns NUMERIC as string; null when no pricing row
  has_active_offer: boolean;
  payment_count: number;       // COUNT()::int — number of rent payments in the window
  days_to_expiry: number;      // (lease_end_date - asOfDate)::int — may be negative for MTM
}

/** Row returned by the DISTINCT ON latest-scores query. */
interface LatestScoreRow {
  resident_id: string;
  lease_id: string;
  risk_score: number;
  risk_tier: string; // enum comes back as string from pg
  days_to_expiry: number | null;
  payment_delinquent: boolean;
  no_renewal_offer: boolean;
  rent_growth_above_market: boolean;
  calculated_at: Date;
  name: string;
  unit_id: string;
  unit_number: string;
}

// ---------------------------------------------------------------------------
// Public-facing shapes (used by routes and later by the webhook service)
// ---------------------------------------------------------------------------

export interface RiskFlag {
  residentId: string;
  name: string;
  unitId: string;    // UUID
  unit: string;      // unit_number (display string)
  leaseId: string;
  riskScore: number;
  riskTier: RiskTier;
  daysToExpiry: number;
  signals: RiskSignals;
}

export interface CalculateResult {
  propertyId: string;
  calculatedAt: string; // ISO 8601
  totalResidents: number;
  flaggedCount: number;
  riskTiers: { high: number; medium: number; low: number };
  flags: RiskFlag[]; // medium + high only, sorted by risk_score DESC
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Single query that fetches every signal needed for scoring in one round-trip.
 *
 * CTEs:
 *   latest_pricing  — most recent market_rent per unit
 *   active_offers   — residents with a pending/accepted renewal offer
 *   payment_counts  — rent payments received in the 6-month window ending asOfDate
 *
 * $1 = propertyId, $2 = asOfDate (YYYY-MM-DD string, cast to ::date in SQL)
 */
const FETCH_RESIDENTS_SQL = `
  WITH latest_pricing AS (
    SELECT DISTINCT ON (unit_id)
      unit_id,
      market_rent
    FROM unit_pricing
    ORDER BY unit_id, effective_date DESC
  ),
  active_offers AS (
    SELECT DISTINCT resident_id
    FROM renewal_offers
    WHERE property_id = $1
      AND status IN ('pending', 'accepted')
  ),
  payment_counts AS (
    SELECT
      resident_id,
      COUNT(*)::int AS payment_count
    FROM resident_ledger
    WHERE property_id        = $1
      AND transaction_type   = 'payment'
      AND charge_code        = 'rent'
      AND transaction_date  >= ($2::date - INTERVAL '6 months')
      AND transaction_date  <= $2::date
    GROUP BY resident_id
  )
  SELECT
    r.id                                 AS resident_id,
    r.first_name || ' ' || r.last_name   AS name,
    r.unit_id,
    u.unit_number,
    l.id                                 AS lease_id,
    l.lease_type,
    l.monthly_rent,
    lp.market_rent,
    (ao.resident_id IS NOT NULL)         AS has_active_offer,
    COALESCE(pc.payment_count, 0)        AS payment_count,
    (l.lease_end_date - $2::date)::int   AS days_to_expiry
  FROM residents r
  JOIN  leases l   ON  l.resident_id = r.id   AND l.status = 'active'
  JOIN  units  u   ON  u.id          = r.unit_id
  LEFT JOIN latest_pricing lp ON lp.unit_id    = r.unit_id
  LEFT JOIN active_offers  ao ON ao.resident_id = r.id
  LEFT JOIN payment_counts pc ON pc.resident_id = r.id
  WHERE r.property_id = $1
    AND r.status      = 'active'
  ORDER BY r.id
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InsertRow {
  residentId: string;
  leaseId: string;
  riskScore: number;
  riskTier: RiskTier;
  daysToExpiry: number;
  paymentDelinquent: boolean;
  noRenewalOffer: boolean;
  rentGrowthAboveMarket: boolean;
}

/**
 * Builds a single parameterised bulk-INSERT statement.
 * Inserting all rows in one statement is significantly faster than N individual
 * INSERTs and keeps the transaction short.
 */
function buildBulkInsert(
  propertyId: string,
  calculatedAt: string,
  rows: InsertRow[],
): { text: string; values: unknown[] } {
  const cols = [
    'property_id', 'resident_id', 'lease_id',
    'risk_score', 'risk_tier',
    'days_to_expiry', 'payment_delinquent', 'no_renewal_offer',
    'rent_growth_above_market', 'calculated_at',
  ];

  const values: unknown[] = [];
  const rowPlaceholders = rows.map((r, i) => {
    const base = i * cols.length;
    values.push(
      propertyId, r.residentId, r.leaseId,
      r.riskScore, r.riskTier,
      r.daysToExpiry, r.paymentDelinquent, r.noRenewalOffer,
      r.rentGrowthAboveMarket, calculatedAt,
    );
    return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  return {
    text: `INSERT INTO renewal_risk_scores (${cols.join(', ')}) VALUES ${rowPlaceholders.join(', ')}`,
    values,
  };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Runs the renewal-risk batch calculation for a single property.
 *
 * Uses a PostgreSQL advisory lock so that two simultaneous calls for the same
 * property do not produce duplicate score rows — the second call blocks until
 * the first transaction commits, then proceeds with fresh data.
 *
 * All scores (including low-risk) are persisted for historical analysis.
 * The response contains only medium + high residents.
 */
export async function calculatePropertyRisk(
  propertyId: string,
  asOfDate: string, // YYYY-MM-DD
): Promise<CalculateResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Transaction-level advisory lock keyed on the property UUID.
    // Released automatically when the transaction ends.
    await client.query(
      `SELECT pg_advisory_xact_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)`,
      [propertyId],
    );

    // Verify the property exists before doing any heavy work.
    const { rowCount } = await client.query(
      `SELECT 1 FROM properties WHERE id = $1 AND status = 'active'`,
      [propertyId],
    );
    if (!rowCount) throw AppError.notFound(`Property ${propertyId} not found`);

    // Fetch all active residents with their signals in a single round-trip.
    const { rows } = await client.query<ResidentRow>(FETCH_RESIDENTS_SQL, [propertyId, asOfDate]);

    // Score every resident.
    const scored = rows.map((row) => {
      const isMonthToMonth = row.lease_type === 'month_to_month';
      const currentRent    = parseFloat(row.monthly_rent);
      const marketRent     = row.market_rent !== null ? parseFloat(row.market_rent) : null;

      // Expected 6 monthly payments; any shortfall is a missed-payment signal.
      const missedRentPaymentsLast6Mo = Math.max(0, 6 - row.payment_count);

      const result = calculateRiskScore({
        isMonthToMonth,
        daysToExpiry: row.days_to_expiry,
        missedRentPaymentsLast6Mo,
        hasActiveRenewalOffer: row.has_active_offer,
        currentRent,
        marketRent,
      });

      return { row, result };
    });

    // calculatedAt represents the asOfDate snapshot, stored as UTC midnight.
    const calculatedAt = `${asOfDate}T00:00:00.000Z`;

    // Bulk-insert all scores (including low-risk) so we have full history.
    if (scored.length > 0) {
      const insertRows: InsertRow[] = scored.map(({ row, result }) => ({
        residentId:           row.resident_id,
        leaseId:              row.lease_id,
        riskScore:            result.riskScore,
        riskTier:             result.riskTier,
        daysToExpiry:         row.days_to_expiry,
        paymentDelinquent:    result.signals.paymentHistoryDelinquent,
        noRenewalOffer:       result.signals.noRenewalOfferYet,
        rentGrowthAboveMarket: result.signals.rentGrowthAboveMarket,
      }));

      const { text, values } = buildBulkInsert(propertyId, calculatedAt, insertRows);
      await client.query(text, values);
    }

    await client.query('COMMIT');

    // Build response — flags contains only medium/high, sorted by score DESC.
    const flags: RiskFlag[] = scored
      .filter(({ result }) => result.riskTier !== 'low')
      .sort((a, b) => b.result.riskScore - a.result.riskScore)
      .map(({ row, result }) => ({
        residentId:  row.resident_id,
        name:        row.name,
        unitId:      row.unit_id,
        unit:        row.unit_number,
        leaseId:     row.lease_id,
        riskScore:   result.riskScore,
        riskTier:    result.riskTier,
        daysToExpiry: row.days_to_expiry,
        signals:     result.signals,
      }));

    const riskTiers = {
      high:   flags.filter((f) => f.riskTier === 'high').length,
      medium: flags.filter((f) => f.riskTier === 'medium').length,
      low:    0, // low-risk residents are not included in the flags array
    };

    return {
      propertyId,
      calculatedAt,
      totalResidents: rows.length,
      flaggedCount: riskTiers.high + riskTiers.medium,
      riskTiers,
      flags,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Returns the most recent risk score per resident for a property.
 * Uses DISTINCT ON so only the latest calculatedAt row is returned per resident.
 * Only medium and high residents are returned (low scores are not actionable).
 */
export async function getLatestPropertyRiskScores(propertyId: string): Promise<{
  flags: RiskFlag[];
  calculatedAt: string | null;
}> {
  const { rows } = await pool.query<LatestScoreRow>(
    `
    SELECT *
    FROM (
      SELECT DISTINCT ON (rrs.resident_id)
        rrs.resident_id,
        rrs.lease_id,
        rrs.risk_score,
        rrs.risk_tier,
        rrs.days_to_expiry,
        rrs.payment_delinquent,
        rrs.no_renewal_offer,
        rrs.rent_growth_above_market,
        rrs.calculated_at,
        r.first_name || ' ' || r.last_name  AS name,
        r.unit_id,
        u.unit_number
      FROM renewal_risk_scores rrs
      JOIN residents r ON r.id  = rrs.resident_id
      JOIN units     u ON u.id  = r.unit_id
      WHERE rrs.property_id = $1
      ORDER BY rrs.resident_id, rrs.calculated_at DESC
    ) latest
    WHERE risk_tier != 'low'
    ORDER BY risk_score DESC
    `,
    [propertyId],
  );

  const flags: RiskFlag[] = rows.map((r) => ({
    residentId:   r.resident_id,
    name:         r.name,
    unitId:       r.unit_id,
    unit:         r.unit_number,
    leaseId:      r.lease_id,
    riskScore:    r.risk_score,
    riskTier:     r.risk_tier as RiskTier,
    daysToExpiry: r.days_to_expiry ?? 0,
    signals: {
      daysToExpiryDays:        r.days_to_expiry ?? 0,
      paymentHistoryDelinquent: r.payment_delinquent,
      noRenewalOfferYet:        r.no_renewal_offer,
      rentGrowthAboveMarket:    r.rent_growth_above_market,
    },
  }));

  const calculatedAt = rows[0]?.calculated_at?.toISOString() ?? null;

  return { flags, calculatedAt };
}
