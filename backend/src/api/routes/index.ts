import { Router } from 'express';
import renewalRiskRouter from './renewalRisk';
import renewalEventsRouter from './renewalEvents';

const router = Router();

router.use('/properties/:propertyId/renewal-risk', renewalRiskRouter);
router.use('/properties/:propertyId/residents/:residentId/renewal-event', renewalEventsRouter);

export default router;
