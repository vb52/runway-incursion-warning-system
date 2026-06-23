import { Router, Request, Response } from 'express';
import { systemStateService } from '../services/SystemStateService';
import { auditService } from '../services/AuditService';

const router = Router();

// GET /api/system/state
router.get('/state', (_req: Request, res: Response) => {
  const state = systemStateService.getSystemState();
  res.json({ success: true, data: state });
});

// POST /api/system/start
router.post('/start', (req: Request, res: Response) => {
  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const previousState = systemStateService.getPowerState();
  const result = systemStateService.startSystem();

  auditService.logAction({
    action_type: 'SYSTEM_START',
    target_type: 'SYSTEM',
    operator_name: operatorName,
    previous_state: previousState,
    new_state: 'INITIALIZING',
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: 'System starting...' });
});

// POST /api/system/stop
router.post('/stop', (req: Request, res: Response) => {
  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const previousState = systemStateService.getPowerState();
  const result = systemStateService.stopSystem();

  auditService.logAction({
    action_type: 'SYSTEM_STOP',
    target_type: 'SYSTEM',
    operator_name: operatorName,
    previous_state: previousState,
    new_state: result.success ? 'SHUTTING_DOWN' : previousState,
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: 'System stopping...' });
});

export default router;
