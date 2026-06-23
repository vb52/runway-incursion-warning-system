import { Router, Request, Response } from 'express';
import { eventService } from '../services/EventService';
import { auditService } from '../services/AuditService';
import { simulationEngine } from '../simulation/SimulationEngine';
import { EventFilters, EventSeverity, EventStatus, TargetType, EventType } from '../types';

const router = Router();

// GET /api/events
router.get('/', (req: Request, res: Response) => {
  const filters: EventFilters = {
    severity: req.query.severity as EventSeverity | undefined,
    status: req.query.status as EventStatus | undefined,
    taxiway_id: req.query.taxiway_id as string | undefined,
    target_type: req.query.target_type as TargetType | undefined,
    event_type: req.query.event_type as EventType | undefined,
    date_from: req.query.date_from as string | undefined,
    date_to: req.query.date_to as string | undefined,
    page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
    pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 20,
  };

  const result = eventService.getEvents(filters);
  res.json({ success: true, ...result });
});

// GET /api/events/:id
router.get('/:id', (req: Request, res: Response) => {
  const event = eventService.getEventById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, error: 'Event not found.' });
  }

  const timeline = eventService.getTimeline(req.params.id);
  const media = eventService.getMedia(req.params.id);

  res.json({ success: true, data: { event, timeline, media } });
});

// POST /api/events (create event via rule engine)
router.post('/', (req: Request, res: Response) => {
  const body = req.body;
  if (!body.taxiway_id || !body.target_id || !body.target_type) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  const result = simulationEngine.processDetection({
    taxiwayId: body.taxiway_id,
    targetId: body.target_id,
    targetType: body.target_type,
    cameraId: body.camera_id ?? 'CAM-01',
    confidence: body.confidence ?? 0.85,
    enteringRunway: body.entering_runway ?? false,
    detected_at: body.detected_at,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.message });
  }

  auditService.logAction({
    action_type: 'EVENT_CREATE_VIA_API',
    target_type: 'EVENT',
    target_id: result.eventCode,
    source_ip: req.ip,
    metadata: { eventId: result.eventId, actions: result.actions },
  });

  res.status(201).json({
    success: true,
    message: result.message,
    data: {
      eventId: result.eventId,
      eventCode: result.eventCode,
      actions: result.actions,
    },
  });
});

// PATCH /api/events/:id/acknowledge
router.patch('/:id/acknowledge', (req: Request, res: Response) => {
  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const result = eventService.acknowledgeEvent(req.params.id, operatorName);

  auditService.logAction({
    action_type: 'EVENT_ACKNOWLEDGE',
    target_type: 'EVENT',
    target_id: req.params.id,
    operator_name: operatorName,
    previous_state: 'NEW',
    new_state: 'ACKNOWLEDGED',
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: result.error ? { error: result.error } : undefined,
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, data: result.event });
});

// PATCH /api/events/:id/close
router.patch('/:id/close', (req: Request, res: Response) => {
  const operatorName = (req.body?.operator_name as string) || 'ATC-01';
  const resolutionNote = (req.body?.resolution_note as string) || '';

  if (!resolutionNote.trim()) {
    return res.status(400).json({ success: false, error: 'Resolution note is required.' });
  }

  const result = eventService.closeEvent(req.params.id, operatorName, resolutionNote);

  auditService.logAction({
    action_type: 'EVENT_CLOSE',
    target_type: 'EVENT',
    target_id: req.params.id,
    operator_name: operatorName,
    previous_state: 'ACKNOWLEDGED',
    new_state: 'CLOSED',
    result: result.success ? 'SUCCESS' : 'FAILED',
    source_ip: req.ip,
    metadata: { resolution_note: resolutionNote },
  });

  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, data: result.event });
});

// POST /api/events/:id/timeline
router.post('/:id/timeline', (req: Request, res: Response) => {
  const event = eventService.getEventById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, error: 'Event not found.' });
  }

  const { action_type, description, source_type, operator_name, metadata } = req.body;
  if (!action_type || !description || !source_type) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  const entry = eventService.addTimeline(req.params.id, {
    action_type,
    description,
    source_type,
    operator_name,
    metadata,
  });

  res.status(201).json({ success: true, data: entry });
});

// GET /api/events/:id/media
router.get('/:id/media', (req: Request, res: Response) => {
  const event = eventService.getEventById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, error: 'Event not found.' });
  }

  const media = eventService.getMedia(req.params.id);
  res.json({ success: true, data: media });
});

export default router;
