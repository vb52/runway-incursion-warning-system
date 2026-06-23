import { DatabaseSync } from 'node:sqlite';
import { ALL_TABLES, SCHEMA_VERSION } from './schema';

export function runMigrations(db: DatabaseSync): void {
  console.log('[DB] Running migrations...');

  // Use PRAGMA via exec (node:sqlite has no .pragma() method)
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  for (const sql of ALL_TABLES) {
    db.exec(sql);
  }

  const versionRow = db
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;

  if (!versionRow) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      new Date().toISOString()
    );
    console.log(`[DB] Schema version ${SCHEMA_VERSION} applied.`);
  } else {
    console.log(`[DB] Schema version ${versionRow.version} already applied.`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
    CREATE INDEX IF NOT EXISTS idx_events_detected_at ON events(detected_at);
    CREATE INDEX IF NOT EXISTS idx_events_taxiway_id ON events(taxiway_id);
    CREATE INDEX IF NOT EXISTS idx_event_timeline_event_id ON event_timeline(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_media_event_id ON event_media(event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at ON audit_logs(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_vlm_analyses_event_id ON event_vlm_analyses(event_id);
    CREATE INDEX IF NOT EXISTS idx_vlm_analyses_status ON event_vlm_analyses(status);
  `);

  console.log('[DB] Migrations complete.');
}
