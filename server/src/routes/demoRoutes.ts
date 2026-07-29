import { Router, Request, Response } from 'express';
import { simulationEngine } from '../simulation/SimulationEngine';
import { auditService } from '../services/AuditService';
import { systemStateService } from '../services/SystemStateService';
import { eventService } from '../services/EventService';

const router = Router();

// POST /api/demo/scenarios/:scenarioId/trigger
router.post('/scenarios/:scenarioId/trigger', async (req: Request, res: Response) => {
  const { scenarioId } = req.params;
  const operatorName = (req.body?.operator_name as string) || 'DEMO-OPERATOR';

  const result = await simulationEngine.triggerScenario(scenarioId);

  auditService.logAction({
    action_type: 'DEMO_SCENARIO_TRIGGER',
    target_type: 'SCENARIO',
    target_id: scenarioId,
    operator_name: operatorName,
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: { message: result.message, eventCode: result.eventCode },
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.message });
  }

  res.json({
    success: true,
    message: result.message,
    data: {
      eventId: result.eventId,
      eventCode: result.eventCode,
      actions: result.actions,
    },
  });
});

// POST /api/demo/reset
router.post('/reset', (_req: Request, res: Response) => {
  // Force-clear system/taxiway state, including any INCURSION_LATCHED
  // taxiways. stopSystem() would silently refuse to do anything here (see
  // SystemStateService.forceReset() for why) — this route needs to actually
  // reset regardless of what state the demo was left in.
  systemStateService.forceReset();

  // Clear all events
  eventService.deleteAllEvents();

  auditService.logAction({
    action_type: 'DEMO_RESET',
    target_type: 'SYSTEM',
    operator_name: 'DEMO-OPERATOR',
    new_state: 'RESET',
  });

  res.json({ success: true, message: 'Demo reset complete. System is OFF.' });
});

// POST /api/demo/detect (direct detection trigger)
router.post('/detect', async (req: Request, res: Response) => {
  const body = req.body;
  const taxiwayId = body.taxiway_id;
  const targetId = body.target_id || 'VEH-001';
  const targetType = body.target_type || 'VEHICLE';
  const cameraId = body.camera_id || 'CAM-01';
  const confidence = body.confidence || 0.90;
  const enteringRunway = body.entering_runway ?? true;

  if (!taxiwayId) {
    return res.status(400).json({ success: false, error: 'taxiway_id is required.' });
  }

  const result = simulationEngine.processDetection({
    taxiwayId,
    targetId,
    targetType,
    cameraId,
    confidence,
    enteringRunway,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.message });
  }

  res.json({
    success: true,
    message: result.message,
    data: {
      eventId: result.eventId,
      eventCode: result.eventCode,
      actions: result.actions,
    },
  });
});

export default router;
