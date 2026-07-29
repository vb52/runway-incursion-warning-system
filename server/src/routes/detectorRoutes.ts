import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { detectorConfigService } from '../services/DetectorConfigService';
import { DetectorRect, DetectorZoneId } from '../types';

const router = Router();

const VIDEO_PATH = path.join(process.cwd(), 'storage', 'detector', 'tpe-airport-live.mp4');

const ZONE_IDS: DetectorZoneId[] = ['A', 'B', 'C'];

function isRect(value: unknown): value is DetectorRect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['x1', 'y1', 'x2', 'y2'].every((k) => typeof r[k] === 'number');
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
  if (b.motion_region !== undefined && b.motion_region !== null && !isRect(b.motion_region)) {
    return 'motion_region must be null or a rect {x1,y1,x2,y2}.';
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
    // Explicit `null` (clear the region) is distinct from "not sent" — only
    // fall back to current when the field is fully absent from the body.
    motion_region: req.body.motion_region !== undefined ? req.body.motion_region : current.motion_region,
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

export default router;
