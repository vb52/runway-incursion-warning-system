import { getDb } from '../database/db';
import { DetectorConfig } from '../types';
import { nowIso } from '../utils/datetime';
import { logger } from '../utils/logger';

// Seed values mirror RIWS-POC/src/riws_poc.py's build_zones()/ROI_RATIO defaults
// for a 1280x720 frame. This is only used until the detector's first
// push_config() call overwrites it with the real stream resolution and layout
// (see RIWS-POC/src/riws_bridge.py).
const DEFAULT_CONFIG: Omit<DetectorConfig, 'updated_at'> = {
  frame_w: 1280,
  frame_h: 720,
  zones: {
    A: { x1: 0, y1: 0, x2: 388, y2: 288 },
    B: { x1: 194, y1: 360, x2: 962, y2: 720 },
    C: { x1: 583, y1: 0, x2: 962, y2: 360 },
  },
  masks: [],
  video_trigger_taxiway_id: '1S',
  video_trigger_seconds: [],
  // 0 = "no reference frame recorded yet" — nothing has been drawn, or the
  // stored zones predate the field. getConfig merges over these defaults, so
  // older rows deserialize to 0 rather than undefined; ZoneConfig.tsx treats
  // 0 as "can't check" and stays quiet instead of warning about a mismatch
  // it has no baseline for.
  motion_frame_w: 0,
  motion_frame_h: 0,
  motion_zones: [],
  // Matches DetectorConfig.tsx's old DEFAULT_MOTION_THRESHOLD, now that the
  // value is persisted here instead of local React state.
  motion_threshold: 0.06,
  incursion_line: null,
};

const CONFIG_ROW_ID = 1;

class DetectorConfigService {
  getConfig(): DetectorConfig {
    const db = getDb();
    const row = db
      .prepare('SELECT config_json FROM detector_config WHERE id = ?')
      .get(CONFIG_ROW_ID) as { config_json: string } | undefined;

    if (!row) {
      const seeded: DetectorConfig = { ...DEFAULT_CONFIG, updated_at: nowIso() };
      this.setConfig(seeded);
      return seeded;
    }

    // Merge over DEFAULT_CONFIG so rows saved before a field was added still
    // deserialize into a complete object instead of undefined-valued fields.
    const parsed = JSON.parse(row.config_json) as Partial<DetectorConfig>;
    return { ...DEFAULT_CONFIG, ...parsed, updated_at: parsed.updated_at ?? nowIso() };
  }

  setConfig(config: Omit<DetectorConfig, 'updated_at'>): DetectorConfig {
    const db = getDb();
    const saved: DetectorConfig = { ...config, updated_at: nowIso() };

    db.prepare(`
      INSERT INTO detector_config (id, config_json, updated_at)
      VALUES (@id, @config_json, @updated_at)
      ON CONFLICT(id) DO UPDATE SET config_json = @config_json, updated_at = @updated_at
    `).run({
      id: CONFIG_ROW_ID,
      config_json: JSON.stringify(saved),
      updated_at: saved.updated_at,
    });

    logger.debug(`[DETECTOR] Config updated (${saved.frame_w}x${saved.frame_h}, ${saved.masks.length} mask(s))`);
    return saved;
  }
}

export const detectorConfigService = new DetectorConfigService();
