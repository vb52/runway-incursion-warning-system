import { Router, Request, Response } from 'express';
import { vlmService } from '../vlm/VlmService';
import { eventService } from '../services/EventService';
import { auditService } from '../services/AuditService';

const router = Router();

// POST /api/events/:id/vlm/analyze
router.post('/:id/vlm/analyze', async (req: Request, res: Response) => {
  const event = eventService.getEventById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, error: 'Event not found.' });
  }

  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const { analysisId, error } = await vlmService.queueAnalysis(req.params.id);

  auditService.logAction({
    action_type: 'VLM_ANALYZE_REQUEST',
    target_type: 'EVENT',
    target_id: req.params.id,
    operator_name: operatorName,
    result: error ? 'FAILED' : 'SUCCESS',
    source_ip: req.ip,
    metadata: { analysisId, error },
  });

  if (error) {
    return res.status(400).json({ success: false, error });
  }

  res.status(202).json({
    success: true,
    message: 'VLM analysis queued.',
    data: { analysisId },
  });
});

// GET /api/events/:id/vlm
router.get('/:id/vlm', (req: Request, res: Response) => {
  const event = eventService.getEventById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, error: 'Event not found.' });
  }

  const analyses = vlmService.getAnalysesForEvent(req.params.id);
  res.json({ success: true, data: analyses });
});

// GET /api/events/:id/vlm/:analysisId
router.get('/:id/vlm/:analysisId', (req: Request, res: Response) => {
  const analysis = vlmService.getAnalysisById(req.params.analysisId);
  if (!analysis || analysis.event_id !== req.params.id) {
    return res.status(404).json({ success: false, error: 'Analysis not found.' });
  }
  res.json({ success: true, data: analysis });
});

// POST /api/events/:id/vlm/retry
router.post('/:id/vlm/retry', async (req: Request, res: Response) => {
  const event = eventService.getEventById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, error: 'Event not found.' });
  }

  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const { analysisId, error } = await vlmService.queueAnalysis(req.params.id);

  auditService.logAction({
    action_type: 'VLM_RETRY',
    target_type: 'EVENT',
    target_id: req.params.id,
    operator_name: operatorName,
    result: error ? 'FAILED' : 'SUCCESS',
    source_ip: req.ip,
    metadata: { analysisId, error },
  });

  if (error) {
    return res.status(400).json({ success: false, error });
  }

  res.status(202).json({
    success: true,
    message: 'VLM analysis retry queued.',
    data: { analysisId },
  });
});

export default router;
