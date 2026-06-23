import { v4 as uuidv4 } from 'uuid';
import { Server as SocketIOServer } from 'socket.io';
import { VlmAnalysisProvider } from './VlmAnalysisProvider';
import { MockVlmProvider } from './MockVlmProvider';
import { HttpVlmProvider } from './HttpVlmProvider';
import { getDb } from '../database/db';
import { eventService } from '../services/EventService';
import {
  VlmAnalysis,
  VlmAnalysisRequest,
  VlmHealthStatus,
  VlmProviderInfo,
  PaginatedResult,
} from '../types';
import { nowIso } from '../utils/datetime';
import { logger } from '../utils/logger';

// SAFETY: VLM processing must not block the primary alert workflow.
// SAFETY: VLM result must never automatically clear a latched incursion alarm.

class VlmService {
  private provider: VlmAnalysisProvider;
  private io: SocketIOServer | null = null;
  private processingQueue: Set<string> = new Set();

  constructor() {
    const providerMode = (process.env.VLM_PROVIDER ?? 'mock').toLowerCase();
    if (providerMode === 'mock') {
      this.provider = new MockVlmProvider();
      logger.info('[VLM] Using Mock VLM Provider.');
    } else if (providerMode === 'http') {
      this.provider = new HttpVlmProvider();
      logger.info('[VLM] Using HTTP VLM Provider.');
    } else {
      logger.warn(`[VLM] Unknown provider "${providerMode}", falling back to Mock.`);
      this.provider = new MockVlmProvider();
    }
  }

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  getProviderInfo(): VlmProviderInfo {
    return this.provider.getProviderInfo();
  }

  async healthCheck(): Promise<VlmHealthStatus> {
    return this.provider.healthCheck();
  }

  // ── Queue VLM Analysis ─────────────────────────────────────────────────────

  async queueAnalysis(eventId: string): Promise<{ analysisId: string; error?: string }> {
    const event = eventService.getEventById(eventId);
    if (!event) {
      return { analysisId: '', error: 'Event not found.' };
    }

    if (this.processingQueue.has(eventId)) {
      return { analysisId: '', error: 'Analysis already in progress for this event.' };
    }

    const db = getDb();
    const analysisId = uuidv4();
    const now = nowIso();
    const promptVersion = process.env.VLM_PROMPT_VERSION ?? 'riws-v1';

    const analysis: VlmAnalysis = {
      id: analysisId,
      event_id: eventId,
      provider: this.provider.getProviderInfo().name,
      model_name: this.provider.getProviderInfo().model,
      prompt_version: promptVersion,
      status: 'QUEUED',
      queued_at: now,
      created_at: now,
      updated_at: now,
    };

    db.prepare(`
      INSERT INTO event_vlm_analyses (
        id, event_id, provider, model_name, prompt_version, status,
        queued_at, created_at, updated_at
      ) VALUES (
        @id, @event_id, @provider, @model_name, @prompt_version, @status,
        @queued_at, @created_at, @updated_at
      )
    `).run({
      id: analysis.id,
      event_id: analysis.event_id,
      provider: analysis.provider ?? null,
      model_name: analysis.model_name ?? null,
      prompt_version: analysis.prompt_version ?? null,
      status: analysis.status,
      queued_at: analysis.queued_at ?? null,
      created_at: analysis.created_at,
      updated_at: analysis.updated_at,
    });

    // Update event's latest VLM analysis ID
    eventService.updateLatestVlmAnalysisId(eventId, analysisId);

    logger.info(`[VLM] Analysis ${analysisId} queued for event ${eventId}.`);
    this.emitVlmUpdate(eventId, analysis);

    // Add timeline entry
    eventService.addTimeline(eventId, {
      action_type: 'VLM_QUEUED',
      description: 'VLM 語意分析已加入佇列',
      source_type: 'VLM',
      occurred_at: now,
      metadata: { analysisId, provider: analysis.provider },
    });

    // SAFETY: Run asynchronously - must not block alert workflow
    this.processAnalysis(analysisId, eventId).catch((err) => {
      logger.error(`[VLM] Async processing error for ${analysisId}:`, err);
    });

    return { analysisId };
  }

  private async processAnalysis(analysisId: string, eventId: string): Promise<void> {
    this.processingQueue.add(eventId);
    const startTime = Date.now();

    try {
      const db = getDb();
      const now = nowIso();

      // Update to PROCESSING
      db.prepare(`
        UPDATE event_vlm_analyses SET status='PROCESSING', started_at=?, updated_at=? WHERE id=?
      `).run(now, now, analysisId);

      const analysis = this.getAnalysisById(analysisId)!;
      this.emitVlmUpdate(eventId, analysis);

      eventService.addTimeline(eventId, {
        action_type: 'VLM_PROCESSING',
        description: 'VLM 語意分析處理中...',
        source_type: 'VLM',
        occurred_at: now,
        metadata: { analysisId },
      });

      // Get event and media
      const event = eventService.getEventById(eventId)!;
      const mediaFiles = eventService.getMedia(eventId);

      const request: VlmAnalysisRequest = {
        eventId,
        analysisId,
        event,
        mediaFiles,
        promptVersion: process.env.VLM_PROMPT_VERSION ?? 'riws-v1',
      };

      // Run VLM analysis
      const result = await this.provider.analyzeEvent(request);

      const completedAt = nowIso();
      const processingTimeMs = Date.now() - startTime;

      if (result.success) {
        db.prepare(`
          UPDATE event_vlm_analyses SET
            status='COMPLETED',
            summary=@summary,
            observed_target_type=@observed_target_type,
            observed_action=@observed_action,
            observed_direction=@observed_direction,
            observed_taxiway=@observed_taxiway,
            runway_entry_observed=@runway_entry_observed,
            risk_assessment=@risk_assessment,
            confidence=@confidence,
            recommended_action=@recommended_action,
            limitations_json=@limitations_json,
            evidence_json=@evidence_json,
            response_payload_json=@response_payload_json,
            model_name=@model_name,
            completed_at=@completed_at,
            processing_time_ms=@processing_time_ms,
            updated_at=@updated_at
          WHERE id=@id
        `).run({
          id: analysisId,
          summary: result.summary ?? null,
          observed_target_type: result.observed_target_type ?? null,
          observed_action: result.observed_action ?? null,
          observed_direction: result.observed_direction ?? null,
          observed_taxiway: result.observed_taxiway ?? null,
          runway_entry_observed: result.runway_entry_observed ?? null,
          risk_assessment: result.risk_assessment ?? null,
          confidence: result.confidence ?? null,
          recommended_action: result.recommended_action ?? null,
          limitations_json: result.limitations ? JSON.stringify(result.limitations) : null,
          evidence_json: result.evidence ? JSON.stringify(result.evidence) : null,
          response_payload_json: result.response_payload ? JSON.stringify(result.response_payload) : null,
          model_name: result.model_name ?? null,
          completed_at: completedAt,
          processing_time_ms: processingTimeMs,
          updated_at: completedAt,
        });

        eventService.addTimeline(eventId, {
          action_type: 'VLM_COMPLETED',
          description: `VLM 分析完成：風險評估 ${result.risk_assessment ?? 'UNCERTAIN'}`,
          source_type: 'VLM',
          occurred_at: completedAt,
          metadata: {
            analysisId,
            risk_assessment: result.risk_assessment,
            confidence: result.confidence,
            processing_time_ms: processingTimeMs,
          },
        });

        logger.info(`[VLM] Analysis ${analysisId} completed in ${processingTimeMs}ms.`);
      } else {
        throw new Error(result.error_message ?? 'VLM analysis returned failure.');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      const now = nowIso();

      const db = getDb();
      db.prepare(`
        UPDATE event_vlm_analyses SET status='FAILED', error_message=?, completed_at=?, updated_at=? WHERE id=?
      `).run(errorMsg, now, now, analysisId);

      eventService.addTimeline(eventId, {
        action_type: 'VLM_FAILED',
        description: `VLM 分析失敗：${errorMsg}`,
        source_type: 'VLM',
        occurred_at: now,
        metadata: { analysisId, error: errorMsg },
      });

      logger.error(`[VLM] Analysis ${analysisId} failed: ${errorMsg}`);
    } finally {
      this.processingQueue.delete(eventId);
      const analysis = this.getAnalysisById(analysisId);
      if (analysis) this.emitVlmUpdate(eventId, analysis);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getAnalysisById(id: string): VlmAnalysis | undefined {
    const db = getDb();
    return db.prepare('SELECT * FROM event_vlm_analyses WHERE id = ?').get(id) as VlmAnalysis | undefined;
  }

  getAnalysesForEvent(eventId: string): VlmAnalysis[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM event_vlm_analyses WHERE event_id = ? ORDER BY created_at DESC
    `).all(eventId) as unknown as VlmAnalysis[];
  }

  getLatestAnalysisForEvent(eventId: string): VlmAnalysis | undefined {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM event_vlm_analyses WHERE event_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(eventId) as VlmAnalysis | undefined;
  }

  // ── Socket Emissions ───────────────────────────────────────────────────────

  private emitVlmUpdate(eventId: string, analysis: VlmAnalysis): void {
    if (!this.io) return;
    this.io.emit('vlm:updated', { eventId, analysis });
  }
}

export const vlmService = new VlmService();
