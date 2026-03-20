import { Request, Response, Router } from 'express';
import { calculatePropertyRisk, getLatestPropertyRiskScores } from '../../services/renewalRiskService';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireDate, requireUuid } from '../validation';

const router = Router({ mergeParams: true });

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
