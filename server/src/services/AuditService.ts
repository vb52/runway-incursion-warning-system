import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database/db';
import { AuditLog, AuditResult, PaginatedResult } from '../types';
import { nowIso } from '../utils/datetime';
import { logger } from '../utils/logger';

// SECURITY: Audit logs are append-only and must never be deleted via normal API.
// All state-changing operations should call logAction().

export interface AuditLogInput {
  operator_name?: string;
  action_type: string;
  target_type?: string;
  target_id?: string;
  previous_state?: string;
  new_state?: string;
  result?: AuditResult;
  source_ip?: string;
  session_id?: string;
  metadata?: unknown;
}

class AuditService {
  logAction(input: AuditLogInput): AuditLog {
    const db = getDb();
    const id = uuidv4();
    const now = nowIso();

    const log: AuditLog = {
      id,
      operator_name: input.operator_name,
      action_type: input.action_type,
      target_type: input.target_type,
      target_id: input.target_id,
      previous_state: input.previous_state,
      new_state: input.new_state,
      result: input.result ?? 'SUCCESS',
      source_ip: input.source_ip,
      session_id: input.session_id,
      occurred_at: now,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
    };

    db.prepare(`
      INSERT INTO audit_logs (
        id, operator_name, action_type, target_type, target_id,
        previous_state, new_state, result, source_ip, session_id,
        occurred_at, metadata_json
      ) VALUES (
        @id, @operator_name, @action_type, @target_type, @target_id,
        @previous_state, @new_state, @result, @source_ip, @session_id,
        @occurred_at, @metadata_json
      )
    `).run({
      id: log.id,
      operator_name: log.operator_name ?? null,
      action_type: log.action_type,
      target_type: log.target_type ?? null,
      target_id: log.target_id ?? null,
      previous_state: log.previous_state ?? null,
      new_state: log.new_state ?? null,
      result: log.result,
      source_ip: log.source_ip ?? null,
      session_id: log.session_id ?? null,
      occurred_at: log.occurred_at,
      metadata_json: log.metadata_json ?? null,
    });

    logger.debug(`[AUDIT] ${log.action_type} by ${log.operator_name ?? 'SYSTEM'} → ${log.result}`);
    return log;
  }

  getLogs(page = 1, pageSize = 50): PaginatedResult<AuditLog> {
    const db = getDb();
    const offset = (page - 1) * pageSize;

    const total = (db.prepare('SELECT COUNT(*) as count FROM audit_logs').get() as { count: number }).count;
    const rows = db.prepare(`
      SELECT * FROM audit_logs ORDER BY occurred_at DESC LIMIT ? OFFSET ?
    `).all(pageSize, offset) as unknown as AuditLog[];

    return {
      data: rows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  getLogById(id: string): AuditLog | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id) as AuditLog | undefined;
  }
}

export const auditService = new AuditService();
