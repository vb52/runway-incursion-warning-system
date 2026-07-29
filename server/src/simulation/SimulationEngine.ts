import { v4 as uuidv4 } from 'uuid';
import { Server as SocketIOServer } from 'socket.io';
import { systemStateService } from '../services/SystemStateService';
import { eventService } from '../services/EventService';
import { auditService } from '../services/AuditService';
import { mediaGeneratorService } from '../media/MediaGeneratorService';
import { vlmService } from '../vlm/VlmService';
import { getDb } from '../database/db';
import { TaxiwayId, EventType, TargetType, EventSeverity } from '../types';
import { nowIso } from '../utils/datetime';
import { logger } from '../utils/logger';

// IMPORTANT: This engine handles demo scenarios.
// Rule engine determines event severity and system state transitions.

export interface DetectionResult {
  taxiwayId: TaxiwayId;
  targetId: string;
  targetType: TargetType;
  cameraId: string;
  confidence: number;
  enteringRunway: boolean;
  detected_at?: string;
  // Real camera frame (base64 JPEG, optionally a data: URI) captured at the
  // moment of detection — see DetectorConfig.tsx's incursion-line scanning.
  // When present, this becomes the event's actual DETECTION_IMAGE instead of
  // the generated placeholder (see MediaGeneratorService.saveDetectionSnapshot).
  snapshotBase64?: string;
}

export interface ScenarioResult {
  success: boolean;
  message: string;
  eventId?: string;
  eventCode?: string;
  actions?: string[];
}

class SimulationEngine {
  private io: SocketIOServer | null = null;

  setSocketIO(io: SocketIOServer): void {
    this.io = io;
  }

  // ── Rule Engine ────────────────────────────────────────────────────────────

  processDetection(detection: DetectionResult): ScenarioResult {
    const systemState = systemStateService.getSystemState();
    const actions: string[] = [];

    // Rule 1: Is STM ACTIVE?
    if (systemState.powerState !== 'ACTIVE') {
      logger.info(`[SIM] Detection ignored: STM is ${systemState.powerState}`);
      return { success: false, message: `STM 未啟動 (${systemState.powerState})，偵測忽略。` };
    }

    // Rule 2: Is RWY ON?
    if (systemState.runwayProtectionState !== 'ON') {
      logger.info('[SIM] Detection ignored: RWY protection is OFF');
      return { success: false, message: 'RWY 保護未啟動，偵測忽略。' };
    }

    // Rule 3: Determine event type based on taxiway state
    const taxiwayState = systemStateService.getTaxiwayState(detection.taxiwayId);
    actions.push(`聯絡道 ${detection.taxiwayId} 當前狀態: ${taxiwayState}`);

    let eventType: EventType;
    let severity: EventSeverity;
    let authorizationState: string;

    if (taxiwayState === 'INCURSION_LATCHED') {
      // Already latched - add dedup timeline
      return {
        success: true,
        message: `聯絡道 ${detection.taxiwayId} 已處於入侵鎖定狀態。`,
      };
    }

    if (detection.enteringRunway) {
      if (taxiwayState === 'AUTHORIZED') {
        // Authorized entry
        eventType = 'AUTHORIZED_ENTRY';
        severity = 'INFO';
        authorizationState = 'AUTHORIZED';
        actions.push('目標已授權進入 → 建立 INFO 事件');
      } else {
        // Unauthorized incursion
        eventType = 'RUNWAY_INCURSION';
        severity = 'RED';
        authorizationState = 'UNAUTHORIZED';
        actions.push('未授權跑道入侵 → 建立 RED 事件 + 鎖定聯絡道');
      }
    } else {
      if (taxiwayState === 'AUTHORIZED') {
        eventType = 'AUTHORIZED_ENTRY';
        severity = 'INFO';
        authorizationState = 'AUTHORIZED';
        actions.push('已授權目標接近 → 建立 INFO 事件');
      } else {
        // Unauthorized approach
        eventType = 'UNAUTHORIZED_APPROACH';
        severity = 'YELLOW';
        authorizationState = 'UNAUTHORIZED';
        actions.push('未授權接近跑道 → 建立 YELLOW 事件');
      }
    }

    // Create event
    const { event, isNew } = eventService.createEvent({
      event_type: eventType,
      severity,
      taxiway_id: detection.taxiwayId,
      target_id: detection.targetId,
      target_type: detection.targetType,
      camera_id: detection.cameraId,
      confidence: detection.confidence,
      authorization_state: authorizationState,
      stm_state: 'ACTIVE',
      runway_state: 'ON',
      taxiway_state_at_detection: taxiwayState,
      detected_at: detection.detected_at ?? nowIso(),
    });

    if (!isNew) {
      return {
        success: true,
        message: `重複偵測 (已存在事件 ${event.event_code})`,
        eventId: event.id,
        eventCode: event.event_code,
        actions,
      };
    }

    // SAFETY: Latch incursion if RED
    if (severity === 'RED' && eventType === 'RUNWAY_INCURSION') {
      systemStateService.latchIncursion(detection.taxiwayId);
      actions.push(`聯絡道 ${detection.taxiwayId} 已鎖定 → INCURSION_LATCHED`);

      // Audit log
      auditService.logAction({
        action_type: 'INCURSION_LATCHED',
        target_type: 'TAXIWAY',
        target_id: detection.taxiwayId,
        previous_state: taxiwayState,
        new_state: 'INCURSION_LATCHED',
        metadata: { eventId: event.id, targetId: detection.targetId },
      });
    }

    // Generate media for RED and YELLOW events
    if (severity === 'RED' || severity === 'YELLOW') {
      try {
        const hasRealSnapshot = typeof detection.snapshotBase64 === 'string' && detection.snapshotBase64.length > 0;
        const mediaRecords = mediaGeneratorService.generateEventMedia(event, { skipDetectionImage: hasRealSnapshot });
        if (hasRealSnapshot) {
          try {
            mediaRecords.push(mediaGeneratorService.saveDetectionSnapshot(event, detection.snapshotBase64!));
          } catch (err) {
            logger.error('[SIM] Failed to save real detection snapshot, falling back to none:', err);
          }
        }
        mediaRecords.forEach((record) => {
          eventService.addMedia(event.id, {
            media_type: record.mediaType,
            file_name: record.fileName,
            file_path: record.filePath,
            camera_id: detection.cameraId,
            captured_at: record.capturedAt,
          });
        });
        actions.push(`生成 ${mediaRecords.length} 個媒體檔案${hasRealSnapshot ? '（含真實偵測截圖）' : ''}`);

        eventService.addTimeline(event.id, {
          action_type: 'MEDIA_GENERATED',
          description: `已生成 ${mediaRecords.length} 個事件影像檔案`,
          source_type: 'SYSTEM',
          occurred_at: nowIso(),
          metadata: { count: mediaRecords.length, files: mediaRecords.map((r) => r.fileName) },
        });
      } catch (err) {
        logger.error('[SIM] Media generation failed:', err);
        actions.push('媒體生成失敗');
      }

      // Queue VLM analysis
      // SAFETY: VLM processing must not block the primary alert workflow.
      if (severity === 'RED') {
        vlmService.queueAnalysis(event.id).then(({ analysisId, error }) => {
          if (error) {
            logger.warn(`[SIM] VLM queue failed for event ${event.id}: ${error}`);
          } else {
            logger.info(`[SIM] VLM analysis ${analysisId} queued for event ${event.id}`);
          }
        });
        actions.push('VLM 分析已加入佇列');
      }
    }

    logger.info(`[SIM] Detection processed → event ${event.event_code} (${severity})`);
    return {
      success: true,
      message: `偵測處理完成 → 事件 ${event.event_code}`,
      eventId: event.id,
      eventCode: event.event_code,
      actions,
    };
  }

  // ── Pre-built Scenarios ────────────────────────────────────────────────────

  async triggerScenario(scenarioId: string): Promise<ScenarioResult> {
    logger.info(`[SIM] Triggering scenario: ${scenarioId}`);

    switch (scenarioId) {
      case 'system-start':
        return this.scenarioSystemStart();
      case 'rwy-on-all-yellow':
        return this.scenarioRwyOnAllYellow();
      case '1s-authorize':
        return this.scenarioAuthorize('1S');
      case '1s-revoke':
        return this.scenarioRevoke('1S');
      case '1s-authorized-entry':
        return this.scenarioAuthorizedEntry('1S');
      case '1n-unauthorized-incursion':
        return this.scenarioUnauthorizedIncursion('1N');
      case '1n-manual-reset':
        return this.scenarioManualReset('1N');
      case 'multi-incursion':
        return this.scenarioMultiIncursion();
      case 'camera-fault':
        return this.scenarioCameraFault();
      case 'vlm-fail':
        return this.scenarioVlmFail();
      case 'system-reset':
        return this.scenarioReset();
      default:
        return { success: false, message: `未知情境: ${scenarioId}` };
    }
  }

  private scenarioSystemStart(): ScenarioResult {
    const result = systemStateService.startSystem();
    if (!result.success) return { success: false, message: result.error ?? 'Failed' };
    auditService.logAction({
      action_type: 'SYSTEM_START',
      target_type: 'SYSTEM',
      previous_state: 'OFF',
      new_state: 'INITIALIZING',
    });
    return { success: true, message: '系統啟動中...（1.5秒後進入 ACTIVE 狀態）' };
  }

  private scenarioRwyOnAllYellow(): ScenarioResult {
    const sys = systemStateService.getSystemState();
    if (sys.powerState !== 'ACTIVE') {
      return { success: false, message: 'STM 必須為 ACTIVE 才能啟動 RWY 保護。' };
    }
    const result = systemStateService.enableRunwayProtection();
    if (!result.success) return { success: false, message: result.error ?? 'Failed' };
    auditService.logAction({
      action_type: 'RUNWAY_ENABLE',
      target_type: 'RUNWAY',
      previous_state: 'OFF',
      new_state: 'ON',
    });
    return { success: true, message: 'RWY 保護已啟動，所有聯絡道設為 GUARDED（黃色）。' };
  }

  private scenarioAuthorize(taxiwayId: TaxiwayId): ScenarioResult {
    const result = systemStateService.authorizeTaxiway(taxiwayId);
    if (!result.success) return { success: false, message: result.error ?? 'Failed' };
    auditService.logAction({
      action_type: 'TAXIWAY_AUTHORIZE',
      target_type: 'TAXIWAY',
      target_id: taxiwayId,
      previous_state: 'GUARDED',
      new_state: 'AUTHORIZED',
    });
    return { success: true, message: `聯絡道 ${taxiwayId} 已授權進入（綠色）。` };
  }

  private scenarioRevoke(taxiwayId: TaxiwayId): ScenarioResult {
    const result = systemStateService.revokeTaxiwayAuthorization(taxiwayId);
    if (!result.success) return { success: false, message: result.error ?? 'Failed' };
    auditService.logAction({
      action_type: 'TAXIWAY_REVOKE',
      target_type: 'TAXIWAY',
      target_id: taxiwayId,
      previous_state: 'AUTHORIZED',
      new_state: 'GUARDED',
    });
    return { success: true, message: `聯絡道 ${taxiwayId} 授權已撤銷（恢復黃色）。` };
  }

  private scenarioAuthorizedEntry(taxiwayId: TaxiwayId): ScenarioResult {
    // First authorize, then simulate authorized entry
    systemStateService.authorizeTaxiway(taxiwayId);
    const result = this.processDetection({
      taxiwayId,
      targetId: 'VEH-010',
      targetType: 'VEHICLE',
      cameraId: 'CAM-03',
      confidence: 0.92,
      enteringRunway: true,
    });
    return result;
  }

  private scenarioUnauthorizedIncursion(taxiwayId: TaxiwayId): ScenarioResult {
    return this.processDetection({
      taxiwayId,
      targetId: 'VEH-001',
      targetType: 'VEHICLE',
      cameraId: 'CAM-01',
      confidence: 0.95,
      enteringRunway: true,
    });
  }

  private scenarioManualReset(taxiwayId: TaxiwayId): ScenarioResult {
    const result = systemStateService.resetTaxiway(taxiwayId);
    if (!result.success) return { success: false, message: result.error ?? 'Failed' };
    auditService.logAction({
      action_type: 'TAXIWAY_RESET',
      target_type: 'TAXIWAY',
      target_id: taxiwayId,
      previous_state: 'INCURSION_LATCHED',
      new_state: 'GUARDED',
      operator_name: 'ATC-01',
    });
    return { success: true, message: `聯絡道 ${taxiwayId} 已人工復歸為 GUARDED 狀態。` };
  }

  private scenarioMultiIncursion(): ScenarioResult {
    const r1 = this.processDetection({
      taxiwayId: '1N',
      targetId: 'VEH-001',
      targetType: 'VEHICLE',
      cameraId: 'CAM-01',
      confidence: 0.95,
      enteringRunway: true,
    });
    const r2 = this.processDetection({
      taxiwayId: '3S',
      targetId: 'PER-001',
      targetType: 'PERSON',
      cameraId: 'CAM-04',
      confidence: 0.88,
      enteringRunway: true,
    });
    return {
      success: true,
      message: `多重入侵觸發 → 1N: ${r1.eventCode ?? 'N/A'}, 3S: ${r2.eventCode ?? 'N/A'}`,
      actions: [...(r1.actions ?? []), ...(r2.actions ?? [])],
    };
  }

  private scenarioCameraFault(): ScenarioResult {
    const { event } = eventService.createEvent({
      event_type: 'CAMERA_FAULT',
      severity: 'YELLOW',
      camera_id: 'CAM-02',
      stm_state: systemStateService.getPowerState(),
      runway_state: systemStateService.getRunwayProtectionState(),
      detected_at: nowIso(),
    });

    eventService.addTimeline(event.id, {
      action_type: 'CAMERA_FAULT_DETECTED',
      description: '攝影機 CAM-02 連線中斷，影像串流已停止',
      source_type: 'DEVICE',
      occurred_at: nowIso(),
      metadata: { camera_id: 'CAM-02', fault_code: 'CONNECTION_LOST' },
    });

    systemStateService.setTaxiwayFault('2N');
    return { success: true, message: `攝影機異常事件已建立 → ${event.event_code}`, eventId: event.id };
  }

  private scenarioVlmFail(): ScenarioResult {
    // Create a detection event, then record a failed VLM analysis
    const { event } = eventService.createEvent({
      event_type: 'RUNWAY_INCURSION',
      severity: 'RED',
      taxiway_id: '5N',
      target_id: 'VEH-099',
      target_type: 'VEHICLE',
      camera_id: 'CAM-06',
      confidence: 0.91,
      authorization_state: 'UNAUTHORIZED',
      stm_state: 'ACTIVE',
      runway_state: 'ON',
      taxiway_state_at_detection: 'GUARDED',
      detected_at: nowIso(),
    });

    // Add media
    try {
      const mediaRecords = mediaGeneratorService.generateEventMedia(event);
      mediaRecords.forEach((record) => {
        eventService.addMedia(event.id, {
          media_type: record.mediaType,
          file_name: record.fileName,
          file_path: record.filePath,
          camera_id: event.camera_id,
          captured_at: record.capturedAt,
        });
      });
    } catch (err) {
      logger.warn('[SIM] Media generation failed for VLM fail scenario:', err);
    }

    // Manually create a FAILED VLM analysis record
    const db = getDb();
    const analysisId = uuidv4();
    const now = nowIso();

    db.prepare(`
      INSERT INTO event_vlm_analyses (
        id, event_id, provider, model_name, prompt_version, status,
        error_message, queued_at, started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      analysisId, event.id, 'mock', 'RIWS-Mock-VLM-v1.0', 'riws-v1', 'FAILED',
      'VLM 服務連線逾時 (TIMEOUT after 15000ms)',
      now, now, now, now, now
    );

    eventService.updateLatestVlmAnalysisId(event.id, analysisId);

    eventService.addTimeline(event.id, {
      action_type: 'VLM_FAILED',
      description: 'VLM 分析失敗：服務連線逾時',
      source_type: 'VLM',
      occurred_at: now,
      metadata: { analysisId, error: 'TIMEOUT' },
    });

    systemStateService.latchIncursion('5N');

    return {
      success: true,
      message: `VLM 失敗情境已觸發 → ${event.event_code}`,
      eventId: event.id,
    };
  }

  private async scenarioReset(): Promise<ScenarioResult> {
    systemStateService.stopSystem();
    auditService.logAction({
      action_type: 'DEMO_RESET',
      target_type: 'SYSTEM',
      new_state: 'RESETTING',
      operator_name: 'ATC-01',
    });
    return { success: true, message: '系統已重設。' };
  }
}

export const simulationEngine = new SimulationEngine();
