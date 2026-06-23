import { Router, Request, Response } from 'express';
import { vlmService } from '../vlm/VlmService';

const router = Router();

// GET /api/vlm/health
router.get('/health', async (_req: Request, res: Response) => {
  const health = await vlmService.healthCheck();
  const info = vlmService.getProviderInfo();
  res.json({ success: true, data: { health, info } });
});

export default router;
