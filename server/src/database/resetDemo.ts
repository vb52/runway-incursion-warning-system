import 'dotenv/config';
import { initDb, getDb } from './db';
import { mediaGeneratorService } from '../media/MediaGeneratorService';
import path from 'path';
import fs from 'fs';

async function resetDemo() {
  console.log('[RESET] Initializing database...');
  initDb();
  const db = getDb();

  console.log('[RESET] Clearing all event data...');

  // Get all event codes to delete media directories
  const events = db.prepare('SELECT event_code FROM events').all() as { event_code: string }[];

  // Delete media files
  for (const { event_code } of events) {
    try {
      mediaGeneratorService.deleteEventMedia(event_code);
    } catch (err) {
      console.warn(`[RESET] Failed to delete media for ${event_code}:`, err);
    }
  }

  // Clear database tables (cascade will handle related records)
  db.exec('DELETE FROM event_vlm_analyses');
  db.exec('DELETE FROM event_media');
  db.exec('DELETE FROM event_timeline');
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM audit_logs');

  console.log('[RESET] All data cleared.');
  console.log('[RESET] System state reset to OFF (in-memory, restart server to apply).');
  console.log('[RESET] Done. Run "npm run seed" to re-populate demo data.');

  process.exit(0);
}

resetDemo().catch((err) => {
  console.error('[RESET] Error:', err);
  process.exit(1);
});
