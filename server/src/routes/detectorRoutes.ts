import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { detectorConfigService } from '../services/DetectorConfigService';
import { detectorAlertService } from '../services/DetectorAlertService';
import { DetectorRect, DetectorZoneId, DetectorMotionZone } from '../types';

const router = Router();

const VIDEO_PATH = path.join(process.cwd(), 'storage', 'detector', 'tpe-airport-live.mp4');

const ZONE_IDS: DetectorZoneId[] = ['A', 'B', 'C'];

function isRect(value: unknown): value is DetectorRect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['x1', 'y1', 'x2', 'y2'].every((k) => typeof r[k] === 'number');
}

function isMotionZone(value: unknown): value is DetectorMotionZone {
  if (typeof value !== 'object' || value === null) return false;
  const z = value as Record<string, unknown>;
  if (typeof z.id !== 'string' || typeof z.taxiway_id !== 'string' || !isRect(z.rect)) return false;
  if (z.threshold !== undefined && (typeof z.threshold !== 'number' || z.threshold < 0 || z.threshold > 1)) return false;
  return true;
}

// Body shape is untrusted input from either the web editor or the Python
// detector (RIWS-POC/src/riws_bridge.py push_config) — validate defensively
// rather than trusting the client-side TypeScript types.
function validateConfigBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'Body must be an object.';
  const b = body as Record<string, unknown>;

  if (typeof b.frame_w !== 'number' || b.frame_w <= 0) return 'frame_w must be a positive number.';
  if (typeof b.frame_h !== 'number' || b.frame_h <= 0) return 'frame_h must be a positive number.';

  if (typeof b.zones !== 'object' || b.zones === null) return 'zones must be an object.';
  const zones = b.zones as Record<string, unknown>;
  for (const zoneId of ZONE_IDS) {
    if (!isRect(zones[zoneId])) return `zones.${zoneId} must be a rect {x1,y1,x2,y2}.`;
  }

  if (!Array.isArray(b.masks) || !b.masks.every(isRect)) {
    return 'masks must be an array of rects {x1,y1,x2,y2}.';
  }

  // Optional on write — RIWS-POC's push_config() never sends these, so PUT
  // falls back to whatever's already stored (see the route handler below)
  // rather than requiring every caller to know about them.
  if (b.video_trigger_taxiway_id !== undefined && typeof b.video_trigger_taxiway_id !== 'string') {
    return 'video_trigger_taxiway_id must be a string.';
  }
  if (b.video_trigger_seconds !== undefined) {
    if (!Array.isArray(b.video_trigger_seconds) || !b.video_trigger_seconds.every((n) => typeof n === 'number')) {
      return 'video_trigger_seconds must be an array of numbers.';
    }
  }
  if (b.motion_zones !== undefined) {
    if (!Array.isArray(b.motion_zones) || !b.motion_zones.every(isMotionZone)) {
      return 'motion_zones must be an array of {id, rect, taxiway_id}.';
    }
  }
  if (b.motion_threshold !== undefined) {
    if (typeof b.motion_threshold !== 'number' || b.motion_threshold < 0 || b.motion_threshold > 1) {
      return 'motion_threshold must be a number between 0 and 1.';
    }
  }
  if (b.incursion_line !== undefined && b.incursion_line !== null && !isMotionZone(b.incursion_line)) {
    return 'incursion_line must be null or {id, rect, taxiway_id}.';
  }

  return null;
}

// GET /api/detector/config
// Read by both the web "偵測器後台管理" editor and RIWS-POC on startup
// (riws_bridge.fetch_config).
router.get('/config', (_req: Request, res: Response) => {
  const config = detectorConfigService.getConfig();
  res.json({ success: true, data: config });
});

// PUT /api/detector/config
// Written by the web editor (operator adjusts zones/masks) and by RIWS-POC
// after a local desktop edit (riws_bridge.push_config), so both sides stay
// in sync regardless of where the edit happened.
router.put('/config', (req: Request, res: Response) => {
  const error = validateConfigBody(req.body);
  if (error) {
    return res.status(400).json({ success: false, error });
  }

  // video_trigger_* fields fall back to the currently stored value when the
  // caller doesn't send them (see validateConfigBody comment above).
  const current = detectorConfigService.getConfig();
  const config = detectorConfigService.setConfig({
    frame_w: req.body.frame_w,
    frame_h: req.body.frame_h,
    zones: req.body.zones,
    masks: req.body.masks,
    video_trigger_taxiway_id:
      typeof req.body.video_trigger_taxiway_id === 'string'
        ? req.body.video_trigger_taxiway_id
        : current.video_trigger_taxiway_id,
    video_trigger_seconds: Array.isArray(req.body.video_trigger_seconds)
      ? req.body.video_trigger_seconds
      : current.video_trigger_seconds,
    motion_zones: Array.isArray(req.body.motion_zones) ? req.body.motion_zones : current.motion_zones,
    motion_threshold: typeof req.body.motion_threshold === 'number' ? req.body.motion_threshold : current.motion_threshold,
    incursion_line: req.body.incursion_line !== undefined ? req.body.incursion_line : current.incursion_line,
  });

  res.json({ success: true, data: config });
});

// GET /api/detector/video
// Serves the looping demo camera clip (server/storage/detector/, gitignored
// — not committed, ~420MB). Both LiveMonitor's preview and DetectorConfig's
// calibration player point <video> at this URL. res.sendFile (not a manual
// fs.createReadStream/.pipe like mediaRoutes.ts uses for small SVGs) so
// Range requests work — the browser needs that to loop/seek a file this
// size without re-fetching it whole every time.
router.get('/video', (_req: Request, res: Response) => {
  if (!fs.existsSync(VIDEO_PATH)) {
    return res.status(404).json({ success: false, error: 'Detector video not found.' });
  }
  res.sendFile(VIDEO_PATH);
});

// POST /api/detector/alert/arm
// Called by ZoneConfig.tsx whenever any of its detection sources
// (AI/motion/manual) reports a plane. See DetectorAlertService — arming (or
// extending) broadcasts to every connected client via Socket.IO
// ('detector:alert-armed'/'detector:alert-cleared') so LiveMonitor's
// countdown matches the detector page's, not just whichever tab armed it.
// may_create (optional, default true) — false for ZoneConfig.tsx's Z2/Z3
// motion-zone hits: only Z1 may start a brand-new alert, Z2/Z3 may only
// extend one Z1 already started (see DetectorAlertService.arm's comment).
router.post('/alert/arm', async (req: Request, res: Response) => {
  const durationMs = req.body?.duration_ms;
  if (typeof durationMs !== 'number' || durationMs <= 0) {
    return res.status(400).json({ success: false, error: 'duration_ms must be a positive number.' });
  }
  const mayCreate = req.body?.may_create !== false;
  await detectorAlertService.arm(durationMs, mayCreate);
  res.json({ success: true, data: detectorAlertService.getState() });
});

// POST /api/detector/alert/clear
// Manual early-clear — DetectorConfig.tsx's "RESET" button. Ends the alert
// window immediately instead of waiting for it to expire on its own.
router.post('/alert/clear', (_req: Request, res: Response) => {
  detectorAlertService.clear();
  res.json({ success: true, data: detectorAlertService.getState() });
});

export default router;
