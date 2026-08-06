import { v4 as uuidv4 } from 'uuid';
import { Server as SocketIOServer } from 'socket.io';
import { getDb } from '../database/db';
import {
  RiwsEvent,
  EventTimeline,
  EventMedia,
  EventSeverity,
  EventStatus,
  EventType,
  TargetType,
  MediaType,
  TimelineSourceType,
  PaginatedResult,
  EventFilters,
} from '../types';
import { nowIso, todayDateString } from '../utils/datetime';
import { logger } from '../utils/logger';

export interface CreateEventInput {
  event_type: EventType;
  severity: EventSeverity;
  taxiway_id?: string;
  target_id?: string;
  target_type?: TargetType;
  camera_id?: string;
  confidence?: number;
  authorization_state?: string;
  stm_state?: string;
  runway_state?: string;
  taxiway_state_at_detection?: string;
  detected_at?: string;
  // Client-generated alertEventId (see client/src/stores/
  // aiDetectionStateStore.ts's buildAlertEventId) that triggered this
  // detection, if any — carried through purely for audit-trail
  // traceability (recorded on the timeline entry's metadata below), not
  // persisted as a dedicated column. The actual idempotency/dedup guarantee
  // is the existing target_id+taxiway_id+event_type+open-status check just
  // above; this is additive, not a replacement for it.
  alertEventId?: string;
}

export interface CreateTimelineInput {
  action_type: string;
  description: string;
  source_type: TimelineSourceType;
  operator_name?: string;
  occurred_at?: string;
  metadata?: unknown;
}

export interface CreateMediaInput {
  media_type: MediaType;
  file_name: string;
  file_path: string;
  camera_id?: string;
  captured_at?: string;
}

class EventService {
  private io: SocketIOServer | null = null;

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  // ── Event Code Generation ──────────────────────────────────────────────────

  private generateEventCode(): string {
    const db = getDb();
    const dateStr = todayDateString();
    const prefix = `RIWS-${dateStr}-`;

    // Find highest sequence number for today
    const row = db.prepare(`
      SELECT event_code FROM events
      WHERE event_code LIKE ?
      ORDER BY event_code DESC
      LIMIT 1
    `).get(`${prefix}%`) as { event_code: string } | undefined;

    let seq = 1;
    if (row) {
      const parts = row.event_code.split('-');
      seq = parseInt(parts[parts.length - 1], 10) + 1;
    }

    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  // ── Create Event ───────────────────────────────────────────────────────────

  createEvent(input: CreateEventInput): { event: RiwsEvent; isNew: boolean } {
    const db = getDb();
    const now = nowIso();
    const detectedAt = input.detected_at ?? now;

    // Deduplication: check if open event exists for same target+taxiway+type
    if (input.target_id && input.taxiway_id) {
      const existing = db.prepare(`
        SELECT * FROM events
        WHERE target_id = ? AND taxiway_id = ? AND event_type = ? AND status != 'CLOSED'
        ORDER BY created_at DESC LIMIT 1
      `).get(input.target_id, input.taxiway_id, input.event_type) as RiwsEvent | undefined;

      if (existing) {
        logger.info(`[EVENT] Dedup hit for ${input.target_id}/${input.taxiway_id}/${input.event_type} → event ${existing.event_code}`);
        // Add timeline entry for repeated detection
        this.addTimeline(existing.id, {
          action_type: 'DETECTION_REPEATED',
          description: `重複偵測到相同目標 ${input.target_id ?? ''} 於 ${input.taxiway_id ?? ''}`,
          source_type: 'SYSTEM',
          occurred_at: detectedAt,
          metadata: { confidence: input.confidence, alertEventId: input.alertEventId },
        });
        return { event: existing, isNew: false };
      }
    }

    const id = uuidv4();
    const event_code = this.generateEventCode();

    const event: RiwsEvent = {
      id,
      event_code,
      event_type: input.event_type,
      severity: input.severity,
      status: 'NEW',
      taxiway_id: input.taxiway_id,
      target_id: input.target_id,
      target_type: input.target_type,
      camera_id: input.camera_id,
      confidence: input.confidence,
      authorization_state: input.authorization_state,
      detected_at: detectedAt,
      stm_state: input.stm_state,
      runway_state: input.runway_state,
      taxiway_state_at_detection: input.taxiway_state_at_detection,
      created_at: now,
      updated_at: now,
    };

    db.prepare(`
      INSERT INTO events (
        id, event_code, event_type, severity, status,
        taxiway_id, target_id, target_type, camera_id, confidence,
        authorization_state, detected_at, stm_state, runway_state,
        taxiway_state_at_detection, created_at, updated_at
      ) VALUES (
        @id, @event_code, @event_type, @severity, @status,
        @taxiway_id, @target_id, @target_type, @camera_id, @confidence,
        @authorization_state, @detected_at, @stm_state, @runway_state,
        @taxiway_state_at_detection, @created_at, @updated_at
      )
    `).run({
      id: event.id,
      event_code: event.event_code,
      event_type: event.event_type,
      severity: event.severity,
      status: event.status,
      taxiway_id: event.taxiway_id ?? null,
      target_id: event.target_id ?? null,
      target_type: event.target_type ?? null,
      camera_id: event.camera_id ?? null,
      confidence: event.confidence ?? null,
      authorization_state: event.authorization_state ?? null,
      detected_at: event.detected_at,
      stm_state: event.stm_state ?? null,
      runway_state: event.runway_state ?? null,
      taxiway_state_at_detection: event.taxiway_state_at_detection ?? null,
      created_at: event.created_at,
      updated_at: event.updated_at,
    });

    // Add initial timeline entry
    this.addTimeline(id, {
      action_type: 'EVENT_CREATED',
      description: `事件建立：${input.event_type} 於 ${input.taxiway_id ?? '未知位置'}`,
      source_type: 'SYSTEM',
      occurred_at: detectedAt,
      metadata: {
        severity: input.severity,
        confidence: input.confidence,
        target_id: input.target_id,
        camera_id: input.camera_id,
        alertEventId: input.alertEventId,
      },
    });

    logger.info(`[EVENT] Created ${event_code} (${input.event_type}, ${input.severity})`);
    this.emitEventCreated(event);
    return { event, isNew: true };
  }

  // ── Acknowledge / Close ────────────────────────────────────────────────────

  acknowledgeEvent(
    id: string,
    operatorName: string
  ): { success: boolean; event?: RiwsEvent; error?: string } {
    const db = getDb();
    const event = this.getEventById(id);
    if (!event) return { success: false, error: 'Event not found.' };
    if (event.status !== 'NEW') return { success: false, error: `Event is already ${event.status}.` };

    const now = nowIso();
    db.prepare(`
      UPDATE events SET status='ACKNOWLEDGED', acknowledged_at=?, operator_name=?, updated_at=? WHERE id=?
    `).run(now, operatorName, now, id);

    this.addTimeline(id, {
      action_type: 'EVENT_ACKNOWLEDGED',
      description: `事件已由操作員 ${operatorName} 確認`,
      source_type: 'OPERATOR',
      operator_name: operatorName,
      occurred_at: now,
    });

    const updated = this.getEventById(id)!;
    this.emitEventUpdated(updated);
    return { success: true, event: updated };
  }

  closeEvent(
    id: string,
    operatorName: string,
    resolutionNote: string
  ): { success: boolean; event?: RiwsEvent; error?: string } {
    const db = getDb();
    const event = this.getEventById(id);
    if (!event) return { success: false, error: 'Event not found.' };
    if (event.status === 'CLOSED') return { success: false, error: 'Event is already closed.' };

    const now = nowIso();
    db.prepare(`
      UPDATE events SET status='CLOSED', closed_at=?, operator_name=?, resolution_note=?, updated_at=? WHERE id=?
    `).run(now, operatorName, resolutionNote, now, id);

    this.addTimeline(id, {
      action_type: 'EVENT_CLOSED',
      description: `事件已由操作員 ${operatorName} 關閉`,
      source_type: 'OPERATOR',
      operator_name: operatorName,
      occurred_at: now,
      metadata: { resolution_note: resolutionNote },
    });

    const updated = this.getEventById(id)!;
    this.emitEventUpdated(updated);
    return { success: true, event: updated };
  }

  updateLatestVlmAnalysisId(eventId: string, analysisId: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE events SET latest_vlm_analysis_id=?, updated_at=? WHERE id=?
    `).run(analysisId, nowIso(), eventId);
    const updated = this.getEventById(eventId);
    if (updated) this.emitEventUpdated(updated);
  }

  // ── Timeline ───────────────────────────────────────────────────────────────

  addTimeline(eventId: string, input: CreateTimelineInput): EventTimeline {
    const db = getDb();
    const id = uuidv4();
    const now = input.occurred_at ?? nowIso();

    const timeline: EventTimeline = {
      id,
      event_id: eventId,
      action_type: input.action_type,
      description: input.description,
      source_type: input.source_type,
      operator_name: input.operator_name,
      occurred_at: now,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
    };

    db.prepare(`
      INSERT INTO event_timeline (id, event_id, action_type, description, source_type, operator_name, occurred_at, metadata_json)
      VALUES (@id, @event_id, @action_type, @description, @source_type, @operator_name, @occurred_at, @metadata_json)
    `).run({
      id: timeline.id,
      event_id: timeline.event_id,
      action_type: timeline.action_type,
      description: timeline.description,
      source_type: timeline.source_type,
      operator_name: timeline.operator_name ?? null,
      occurred_at: timeline.occurred_at,
      metadata_json: timeline.metadata_json ?? null,
    });

    return timeline;
  }

  getTimeline(eventId: string): EventTimeline[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM event_timeline WHERE event_id = ? ORDER BY occurred_at ASC
    `).all(eventId) as unknown as EventTimeline[];
  }

  // ── Media ──────────────────────────────────────────────────────────────────

  addMedia(eventId: string, input: CreateMediaInput): EventMedia {
    const db = getDb();
    const id = uuidv4();
    const now = nowIso();

    const media: EventMedia = {
      id,
      event_id: eventId,
      media_type: input.media_type,
      file_name: input.file_name,
      file_path: input.file_path,
      camera_id: input.camera_id,
      captured_at: input.captured_at ?? now,
      created_at: now,
    };

    db.prepare(`
      INSERT INTO event_media (id, event_id, media_type, file_name, file_path, camera_id, captured_at, created_at)
      VALUES (@id, @event_id, @media_type, @file_name, @file_path, @camera_id, @captured_at, @created_at)
    `).run({
      id: media.id,
      event_id: media.event_id,
      media_type: media.media_type,
      file_name: media.file_name,
      file_path: media.file_path,
      camera_id: media.camera_id ?? null,
      captured_at: media.captured_at,
      created_at: media.created_at,
    });

    return media;
  }

  getMedia(eventId: string): EventMedia[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM event_media WHERE event_id = ? ORDER BY captured_at ASC
    `).all(eventId) as unknown as EventMedia[];
  }

  getMediaById(mediaId: string): EventMedia | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM event_media WHERE id = ?').get(mediaId) as EventMedia | undefined;
  }

  // Drops every media row of one type for an event. Used when a real captured
  // file arrives for a slot that already holds a generated placeholder (see
  // the attach-media route) — without this the event would list two
  // PRE/POST_EVENT_IMAGEs and the review UI would show the placeholder and
  // the real frame side by side as if both were evidence.
  //
  // Only the DB rows go; the placeholder file itself is left on disk. It is
  // small, it is inside the event's own directory (removed wholesale by
  // deleteEventMedia), and deleting files here would make this operation
  // non-idempotent for no benefit.
  removeMediaOfType(eventId: string, mediaType: MediaType): number {
    const db = getDb();
    const result = db.prepare('DELETE FROM event_media WHERE event_id = ? AND media_type = ?').run(eventId, mediaType);
    return Number(result.changes ?? 0);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getEventById(id: string): RiwsEvent | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as RiwsEvent | undefined;
  }

  getEventByCode(code: string): RiwsEvent | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM events WHERE event_code = ?').get(code) as RiwsEvent | undefined;
  }

  // Every still-open RUNWAY_INCURSION on a taxiway, newest first — the events
  // a 復歸 on that taxiway is resolving.
  //
  // Returns a LIST, not one event, and that is the point: since detections
  // carry a real per-aircraft target_id, two aircraft can each hold their own
  // open incursion event on the same taxiway (see createEvent's dedup and
  // SimulationEngine's INCURSION_LATCHED comment). A 復歸 clears the taxiway's
  // single latch, which is what ALL of them contributed to — so the operator's
  // action belongs on each of their timelines, not only the most recent one.
  // Picking just one would leave the others reading as never resolved.
  getOpenIncursionEvents(taxiwayId: string): RiwsEvent[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM events
      WHERE taxiway_id = ? AND event_type = 'RUNWAY_INCURSION' AND status != 'CLOSED'
      ORDER BY detected_at DESC
    `).all(taxiwayId) as unknown as RiwsEvent[];
  }

  getEvents(filters: EventFilters = {}): PaginatedResult<RiwsEvent> {
    const db = getDb();
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.severity) {
      conditions.push('severity = ?');
      params.push(filters.severity);
    }
    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.taxiway_id) {
      conditions.push('taxiway_id = ?');
      params.push(filters.taxiway_id);
    }
    if (filters.target_type) {
      conditions.push('target_type = ?');
      params.push(filters.target_type);
    }
    if (filters.event_type) {
      conditions.push('event_type = ?');
      params.push(filters.event_type);
    }
    if (filters.date_from) {
      conditions.push('detected_at >= ?');
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      conditions.push('detected_at <= ?');
      params.push(filters.date_to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sort: NEW RED first, then ACKNOWLEDGED RED, NEW YELLOW, etc.
    const orderBy = `
      ORDER BY
        CASE status WHEN 'NEW' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END ASC,
        CASE severity WHEN 'RED' THEN 0 WHEN 'YELLOW' THEN 1 ELSE 2 END ASC,
        detected_at DESC
    `;

    const countSql = `SELECT COUNT(*) as count FROM events ${where}`;
    const dataSql = `SELECT * FROM events ${where} ${orderBy} LIMIT ? OFFSET ?`;

    // better-sqlite3 accepts positional array via spread
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const total = ((db.prepare(countSql) as any).get(...params) as { count: number }).count;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (db.prepare(dataSql) as any).all(...params, pageSize, offset) as RiwsEvent[];

    // Filter by VLM status requires joining - handle separately if needed
    // TODO: Join with event_vlm_analyses for vlm_status filter

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  deleteAllEvents(): void {
    const db = getDb();
    db.exec('DELETE FROM event_vlm_analyses');
    db.exec('DELETE FROM event_media');
    db.exec('DELETE FROM event_timeline');
    db.exec('DELETE FROM events');
    logger.warn('[EVENT] All events deleted (demo reset).');
  }

  // ── Socket Emissions ───────────────────────────────────────────────────────

  private emitEventCreated(event: RiwsEvent): void {
    if (!this.io) return;
    this.io.emit('event:created', { event });
  }

  private emitEventUpdated(event: RiwsEvent): void {
    if (!this.io) return;
    this.io.emit('event:updated', { event });
  }
}

export const eventService = new EventService();
