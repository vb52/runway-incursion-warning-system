// IMPORTANT: Uses Node.js 24 built-in node:sqlite (stable, no native compilation needed).
// INTEGRATION: For multi-process deployments, replace with a proper database server (PostgreSQL, etc.).
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { runMigrations } from './migrations';

// IMPORTANT: Single database instance for the entire server process.
let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return _db;
}

export function initDb(): DatabaseSync {
  const dbPath = process.env.DB_PATH || './storage/riws.db';
  const absoluteDbPath = path.isAbsolute(dbPath)
    ? dbPath
    : path.join(process.cwd(), dbPath);

  const storageDir = path.dirname(absoluteDbPath);
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  console.log(`[DB] Initializing SQLite database at: ${absoluteDbPath}`);

  _db = new DatabaseSync(absoluteDbPath);

  runMigrations(_db);

  console.log('[DB] Database initialized successfully.');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    console.log('[DB] Database connection closed.');
  }
}
