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
  // A real frame from N seconds BEFORE the detection, taken from the client's
  // rolling pre-event buffer (ZoneConfig.tsx's preEventFramesRef). Becomes the
  // event's PRE_EVENT_IMAGE instead of the drawn placeholder. Absent whenever
  // the buffer couldn't offer a trustworthy frame — it is cleared on video
  // seek/RESET, since a frame from elsewhere in the clip would misrepresent
  // what the scene looked like before this incursion.
  preSnapshotBase64?: string;
  // When preSnapshotBase64 was actually grabbed (ISO). Recorded separately
  // because it is deliberately EARLIER than the event's detected_at.
  preSnapshotCapturedAt?: string;
  // Client-generated alertEventId (see aiDetectionStateStore.ts's
  // buildAlertEventId) — passed through to EventService.createEvent purely
  // for audit-trail traceability. See CreateEventInput.alertEventId.
  alertEventId?: string;
}

export interface ScenarioResult {
  success: boolean;
  message: string;
  eventId?: string;
  eventCode?: string;
  actions?: string[];
  // Whether this detection created a brand-new event or was absorbed into an
  // existing open one (see EventService.createEvent's dedup). Surfaced to the
  // caller because the client schedules a delayed 事後影像 capture and must
  // only attach it to an event THIS detection actually opened — attaching it
  // to a dedup hit would overwrite the post-event frame of an earlier
  // aircraft's still-open incursion with a later, unrelated one.
  isNew?: boolean;
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

    // NOT short-circuited when the taxiway is already INCURSION_LATCHED.
    //
    // 一條聯絡道被鎖定，指的是「這架飛機的入侵還沒被復歸」，不是「這條聯絡道
    // 之後發生什麼都不用記錄」. A second aircraft entering the same taxiway
    // while the first incursion is still un-復歸'd is a SECOND hazard and
    // gets its own event, its own截圖 and its own VLM analysis — an operator
    // reviewing the incident must be able to see that two aircraft were
    // involved, not one.
    //
    // This used to `return` here. Because the latch survives until an
    // explicit 復歸, that silently discarded every detection in between —
    // no event, no media, and (unlike the dedup path below) not even a
    // timeline row, so nothing recorded that a detection had happened at
    // all. The alarm still sounded client-side, which is how it showed up:
    // 警報有響、事件沒建立.
    //
    // Dedup for the SAME aircraft is not lost by falling through —
    // eventService.createEvent already collapses a repeat detection of the
    // same target_id + taxiway_id + event_type onto the existing open event
    // (returning isNew:false, handled below). That check is the right place
    // for it: it keys off the aircraft's identity, whereas this branch could
    // only ever key off the taxiway.
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
      alertEventId: detection.alertEventId,
      detected_at: detection.detected_at ?? nowIso(),
    });

    if (!isNew) {
      return {
        success: true,
        message: `重複偵測 (已存在事件 ${event.event_code})`,
        eventId: event.id,
        eventCode: event.event_code,
        actions,
        isNew: false,
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

      // ...and onto the EVENT's own timeline, not just the global audit log.
      // The two answer different questions: audit_logs is "what did the system
      // do, across everything", the event timeline is "what happened to THIS
      // incursion". An operator reviewing one incident reads the latter, and
      // the latch — the single most consequential automatic action taken —
      // was missing from it entirely.
      eventService.addTimeline(event.id, {
        action_type: 'INCURSION_LATCHED',
        description: `聯絡道 ${detection.taxiwayId} 已自動鎖定為 INCURSION_LATCHED 狀態，須人工復歸`,
        source_type: 'SYSTEM',
        occurred_at: nowIso(),
        metadata: { taxiway: detection.taxiwayId, previous_state: taxiwayState },
      });

      // The alarm going out is itself part of the record: it is what turns a
      // detection into something a human was actually told about. Client count
      // comes from Socket.IO rather than being assumed — an incursion
      // broadcast to ZERO connected clients is exactly the kind of thing an
      // incident review needs to be able to see, and it would otherwise leave
      // no trace anywhere.
      const clientCount = this.io?.engine?.clientsCount ?? 0;
      eventService.addTimeline(event.id, {
        action_type: 'ALERT_BROADCAST',
        description: clientCount > 0
          ? `跑道入侵警報已廣播至 ${clientCount} 個連線端`
          : '跑道入侵警報已發出，但當時沒有任何連線端可接收',
        source_type: 'SYSTEM',
        occurred_at: nowIso(),
        metadata: { clientCount, severity, alertEventId: detection.alertEventId },
      });
    }

    // Generate media for RED and YELLOW events — and for ANY event that
    // arrived with a real camera frame attached.
    //
    // hasRealSnapshot is part of the condition, not just of the body, because
    // a severity-only gate threw away evidence the client had already
    // captured and uploaded: 跑道入侵線 grabs the frame and POSTs it on every
    // crossing (see ZoneConfig.tsx's captureSnapshot), but if the taxiway
    // happened to be AUTHORIZED at that moment the event is INFO
    // (AUTHORIZED_ENTRY) and this whole block was skipped — the JPEG was
    // silently dropped and the event ended up with no media at all. A real
    // photograph of an aircraft entering the runway is worth keeping
    // regardless of how the authorization check classified it; that
    // classification can be wrong or change, the frame can't be re-taken.
    //
    // An INFO event with NO snapshot still gets nothing, exactly as before —
    // this is about not discarding real evidence, not about generating
    // placeholder art for routine authorized movements.
    const hasRealSnapshot = typeof detection.snapshotBase64 === 'string' && detection.snapshotBase64.length > 0;
    // The client keeps a rolling one-frame-per-second buffer of the seconds
    // BEFORE the trigger (see ZoneConfig.tsx's preEventFramesRef) and sends
    // the oldest one along, so 事前影像 is the actual approach rather than a
    // drawn "MONITORING / no target in frame" placeholder. Optional — the
    // buffer is deliberately dropped on seek/RESET, since frames from a
    // different part of the clip would be a misleading "before" picture.
    const hasRealPreSnapshot = typeof detection.preSnapshotBase64 === 'string' && detection.preSnapshotBase64.length > 0;
    if (severity === 'RED' || severity === 'YELLOW' || hasRealSnapshot) {
      try {
        const mediaRecords = mediaGeneratorService.generateEventMedia(event, {
          skipDetectionImage: hasRealSnapshot,
          skipPreEventImage: hasRealPreSnapshot,
        });
        if (hasRealSnapshot) {
          try {
            mediaRecords.push(mediaGeneratorService.saveBinaryMedia(event, detection.snapshotBase64!, {
              mediaType: 'DETECTION_IMAGE',
              fileName: 'detection.jpg',
            }));
          } catch (err) {
            logger.error('[SIM] Failed to save real detection snapshot, falling back to none:', err);
          }
        }
        if (hasRealPreSnapshot) {
          try {
            mediaRecords.push(mediaGeneratorService.saveBinaryMedia(event, detection.preSnapshotBase64!, {
              mediaType: 'PRE_EVENT_IMAGE',
              fileName: 'pre-event.jpg',
              // Stamped with when the frame was actually grabbed, not with
              // event time — the whole point of 事前影像 is that it predates
              // the detection, and the review UI shows this timestamp.
              capturedAt: detection.preSnapshotCapturedAt,
            }));
          } catch (err) {
            logger.error('[SIM] Failed to save real pre-event snapshot, falling back to placeholder:', err);
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
        const realCount = (hasRealSnapshot ? 1 : 0) + (hasRealPreSnapshot ? 1 : 0);
        actions.push(`生成 ${mediaRecords.length} 個媒體檔案${realCount > 0 ? `（含 ${realCount} 張真實影像）` : ''}`);

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
      isNew: true,
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
