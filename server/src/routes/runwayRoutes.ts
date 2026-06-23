import { Router, Request, Response } from 'express';
import { systemStateService } from '../services/SystemStateService';
import { auditService } from '../services/AuditService';

const router = Router();

// POST /api/runway/enable
router.post('/enable', (req: Request, res: Response) => {
  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const previousState = systemStateService.getRunwayProtectionState();
  const result = systemStateService.enableRunwayProtection();

  auditService.logAction({
    action_type: 'RUNWAY_ENABLE',
    target_type: 'RUNWAY',
    operator_name: operatorName,
    previous_state: previousState,
    new_state: result.success ? 'ON' : previousState,
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: 'Runway protection enabled.' });
});

// POST /api/runway/disable
router.post('/disable', (req: Request, res: Response) => {
  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const previousState = systemStateService.getRunwayProtectionState();
  const result = systemStateService.disableRunwayProtection();

  auditService.logAction({
    action_type: 'RUNWAY_DISABLE',
    target_type: 'RUNWAY',
    operator_name: operatorName,
    previous_state: previousState,
    new_state: result.success ? 'OFF' : previousState,
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: 'Runway protection disabled.' });
});

export default router;
