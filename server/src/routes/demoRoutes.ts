import { Router, Request, Response } from 'express';
import { simulationEngine } from '../simulation/SimulationEngine';
import { auditService } from '../services/AuditService';
import { systemStateService } from '../services/SystemStateService';
import { eventService } from '../services/EventService';
import { detectorAlertService } from '../services/DetectorAlertService';

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

  // Also clear any live runway-alert countdown from the video detector —
  // NOT suppressed here (see DetectorAlertService.clear's comment): this
  // route also clears whatever AirportSimPanel's DEMO-START vehicles
  // latched (they share the same safety pipeline as LIVE detections), and
  // that's unrelated to whether a real LIVE alert should be allowed to
  // re-arm. DetectorConfig.tsx's own RESET button and AirportSimPanel's
  // panel-local RESET still suppress — this is specifically about not
  // letting a demo test's cleanup silence real detection as a side effect.
  detectorAlertService.clear(false);
  // Tell DetectorConfig.tsx to drop its client-side Z1+Z2 runway-holding
  // latch too — see notifyDemoReset's comment.
  detectorAlertService.notifyDemoReset();

  // Clear all events
  eventService.deleteAllEvents();

  // Clear all audit log entries too (操作紀錄頁面) — run before the
  // DEMO_RESET entry below is written, so that entry is the one thing left
  // recording the reset itself, not also wiped by its own cleanup.
  auditService.deleteAllLogs();

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
  // Real camera frame from the incursion-line trigger (see
  // DetectorConfig.tsx) — optional, JSON body so no multipart/upload
  // handling needed. Anything else keeps working exactly as before.
  const snapshotBase64 = typeof body.snapshot_base64 === 'string' ? body.snapshot_base64 : undefined;
  // Client-generated alertEventId (see aiDetectionStateStore.ts's
  // buildAlertEventId) — optional, purely for audit-trail traceability. See
  // SimulationEngine.DetectionResult.alertEventId / EventService.
  // CreateEventInput.alertEventId.
  const alertEventId = typeof body.alert_event_id === 'string' ? body.alert_event_id : undefined;

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
    snapshotBase64,
    alertEventId,
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
