import { Router, Request, Response } from 'express';
import { getDb } from '../database/db';
import { systemStateService } from '../services/SystemStateService';
import { vlmService } from '../vlm/VlmService';
import { nowIso } from '../utils/datetime';
import fs from 'fs';
import path from 'path';

const router = Router();

// GET /api/health
router.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'RIWS Server',
    version: '1.0.0',
    timestamp: nowIso(),
  });
});

// GET /api/diagnostics
router.get('/diagnostics', async (_req: Request, res: Response) => {
  const diagnosticsEnabled = process.env.ENABLE_DIAGNOSTICS === 'true';
  if (!diagnosticsEnabled) {
    return res.status(403).json({
      success: false,
      error: 'Diagnostics endpoint disabled. Set ENABLE_DIAGNOSTICS=true to enable.',
    });
  }

  // Database check
  let dbStatus = 'ok';
  let dbError: string | undefined;
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
    dbStatus = `ok (${row.count} events)`;
  } catch (err) {
    dbStatus = 'error';
    dbError = err instanceof Error ? err.message : 'Unknown error';
  }

  // Media storage check
  const mediaPath = process.env.MEDIA_STORAGE_PATH || './storage/events';
  const absoluteMediaPath = path.isAbsolute(mediaPath)
    ? mediaPath
    : path.join(process.cwd(), mediaPath);
  const mediaExists = fs.existsSync(absoluteMediaPath);

  // VLM health check
  let vlmHealth;
  try {
    vlmHealth = await vlmService.healthCheck();
  } catch {
    vlmHealth = { healthy: false, error: 'Health check failed' };
  }

  const systemState = systemStateService.getSystemState();

  res.json({
    success: true,
    timestamp: nowIso(),
    system: {
      powerState: systemState.powerState,
      runwayProtectionState: systemState.runwayProtectionState,
    },
    database: {
      status: dbStatus,
      error: dbError,
      path: process.env.DB_PATH || './storage/riws.db',
    },
    mediaStorage: {
      status: mediaExists ? 'ok' : 'missing',
      path: absoluteMediaPath,
    },
    vlm: {
      ...vlmHealth,
      provider: vlmService.getProviderInfo(),
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT || '3001',
    },
  });
});

export default router;
