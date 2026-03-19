import { Request, Response, Router } from 'express';
import { AppError } from '../../errors';
import { calculatePropertyRisk, getLatestPropertyRiskScores } from '../../services/renewalRiskService';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Validation helpers (no external deps needed for these simple checks)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`${name} must be a valid UUID`);
  }
  return value;
}

function requireDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw AppError.badRequest(`${name} must be a date in YYYY-MM-DD format`);
  }
  // Ensure the date is actually valid (e.g. rejects "2025-02-30")
  const d = new Date(`${value}T00:00:00.000Z`);
  if (isNaN(d.getTime())) {
    throw AppError.badRequest(`${name} is not a valid calendar date`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// POST /api/v1/properties/:propertyId/renewal-risk/calculate
// ---------------------------------------------------------------------------

router.post(
  '/calculate',
  asyncHandler(async (req: Request, res: Response) => {
    const propertyId = requireUuid(req.params.propertyId, 'propertyId');
    const asOfDate   = requireDate(req.body?.asOfDate, 'asOfDate');

    const result = await calculatePropertyRisk(propertyId, asOfDate);

    res.status(200).json(result);
  }),
);

// ---------------------------------------------------------------------------
// GET /api/v1/properties/:propertyId/renewal-risk
// ---------------------------------------------------------------------------

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const propertyId = requireUuid(req.params.propertyId, 'propertyId');

    const { flags, calculatedAt } = await getLatestPropertyRiskScores(propertyId);

    res.status(200).json({ propertyId, calculatedAt, flags });
  }),
);

export default router;
