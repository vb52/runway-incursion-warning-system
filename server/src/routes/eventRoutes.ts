import { Router, Request, Response } from 'express';
import { eventService } from '../services/EventService';
import { auditService } from '../services/AuditService';
import { simulationEngine } from '../simulation/SimulationEngine';
import { mediaGeneratorService } from '../media/MediaGeneratorService';
import { logger } from '../utils/logger';
import { EventFilters, EventSeverity, EventStatus, TargetType, EventType, MediaType } from '../types';

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

// POST /api/events/:id/media
// Attaches media that can only exist AFTER the event was created — the
// delayed 事後影像 frame and the 事件影片 clip, both captured client-side and
// uploaded once the recording window has actually elapsed (see
// ZoneConfig.tsx's schedulePostEventCapture / event-video recorder).
//
// Restricted to those two slots on purpose. PRE/DETECTION images arrive with
// the detection itself (POST /api/demo/detect) where they are bound to the
// same authorization decision that classified the event; letting a later,
// unauthenticated call overwrite the frame the incursion was JUDGED on would
// make the primary evidence mutable after the fact.
const ATTACHABLE_MEDIA_TYPES: MediaType[] = ['POST_EVENT_IMAGE', 'EVENT_VIDEO'];
const MEDIA_FILE_NAMES: Record<string, string> = {
  POST_EVENT_IMAGE: 'post-event.jpg',
  EVENT_VIDEO: 'event-video.webm',
};

router.post('/:id/media', (req: Request, res: Response) => {
  const event = eventService.getEventById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, error: 'Event not found.' });
  }

  const mediaType = req.body?.media_type as MediaType;
  if (!ATTACHABLE_MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({
      success: false,
      error: `media_type must be one of ${ATTACHABLE_MEDIA_TYPES.join(', ')}.`,
    });
  }

  const base64 = req.body?.base64;
  if (typeof base64 !== 'string' || base64.length === 0) {
    return res.status(400).json({ success: false, error: 'base64 is required.' });
  }

  try {
    const record = mediaGeneratorService.saveBinaryMedia(event, base64, {
      mediaType,
      fileName: MEDIA_FILE_NAMES[mediaType],
      capturedAt: typeof req.body?.captured_at === 'string' ? req.body.captured_at : undefined,
    });

    // Replace, don't accumulate — the generated placeholder for this slot (or
    // an earlier upload of the same slot) must not survive alongside the real
    // file. See EventService.removeMediaOfType.
    const replaced = eventService.removeMediaOfType(event.id, mediaType);
    const media = eventService.addMedia(event.id, {
      media_type: record.mediaType,
      file_name: record.fileName,
      file_path: record.filePath,
      camera_id: typeof req.body?.camera_id === 'string' ? req.body.camera_id : event.camera_id,
      captured_at: record.capturedAt,
    });

    eventService.addTimeline(event.id, {
      action_type: mediaType === 'EVENT_VIDEO' ? 'EVENT_VIDEO_RECORDED' : 'POST_EVENT_CAPTURED',
      description: mediaType === 'EVENT_VIDEO'
        ? '事件影片錄製完成並歸檔'
        : '事後影像已擷取並歸檔',
      source_type: 'SYSTEM',
      metadata: { media_type: mediaType, file_name: record.fileName, replaced_placeholder: replaced > 0 },
    });

    res.status(201).json({ success: true, data: media });
  } catch (err) {
    logger.error('[EVENT] Failed to attach media:', err);
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Failed to attach media.' });
  }
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
