import 'dotenv/config';
import { initDb } from './db';
import { eventService } from '../services/EventService';
import { mediaGeneratorService } from '../media/MediaGeneratorService';
import { nowIso } from '../utils/datetime';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db';

// MOCK: Seed data for demonstration. All data is fictitious.
// Base: 演示基地 A, RWY 18/36, cameras CAM-01 through CAM-06

async function seed() {
  console.log('[SEED] Initializing database...');
  initDb();
  const db = getDb();

  // Check if already seeded
  const existingCount = (db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count;
  if (existingCount > 0) {
    console.log(`[SEED] Database already has ${existingCount} events. Skipping seed.`);
    console.log('[SEED] Run reset-demo first to clear data.');
    process.exit(0);
  }

  const now = Date.now();

  // ── Event 1: RED, NEW, 1N, VEHICLE incursion (VEH-001, CAM-01) ──────────
  console.log('[SEED] Creating Event 1: RED incursion 1N...');
  const { event: ev1 } = eventService.createEvent({
    event_type: 'RUNWAY_INCURSION',
    severity: 'RED',
    taxiway_id: '1N',
    target_id: 'VEH-001',
    target_type: 'VEHICLE',
    camera_id: 'CAM-01',
    confidence: 0.95,
    authorization_state: 'UNAUTHORIZED',
    stm_state: 'ACTIVE',
    runway_state: 'ON',
    taxiway_state_at_detection: 'GUARDED',
    detected_at: new Date(now - 15 * 60 * 1000).toISOString(),
  });

  eventService.addTimeline(ev1.id, {
    action_type: 'DETECTION_CONFIRMED',
    description: 'AI 視覺系統確認 VEH-001 越越聯絡道 1N 邊界進入跑道',
    source_type: 'AI',
    occurred_at: new Date(now - 15 * 60 * 1000 + 2000).toISOString(),
    metadata: { confidence: 0.95, model: 'RIWS-Detector-v1' },
  });

  eventService.addTimeline(ev1.id, {
    action_type: 'INCURSION_LATCHED',
    description: '聯絡道 1N 已自動鎖定為 INCURSION_LATCHED 狀態',
    source_type: 'SYSTEM',
    occurred_at: new Date(now - 15 * 60 * 1000 + 3000).toISOString(),
    metadata: { taxiway: '1N', previous_state: 'GUARDED' },
  });

  eventService.addTimeline(ev1.id, {
    action_type: 'ALERT_BROADCAST',
    description: '跑道入侵警報已廣播，通知所有在場人員',
    source_type: 'SYSTEM',
    occurred_at: new Date(now - 15 * 60 * 1000 + 4000).toISOString(),
  });

  // Generate media for Event 1
  const media1 = mediaGeneratorService.generateEventMedia(ev1);
  media1.forEach((record) => {
    eventService.addMedia(ev1.id, {
      media_type: record.mediaType,
      file_name: record.fileName,
      file_path: record.filePath,
      camera_id: 'CAM-01',
      captured_at: record.capturedAt,
    });
  });

  // VLM Analysis for Event 1 (COMPLETED)
  const vlm1Id = uuidv4();
  const vlm1CreatedAt = new Date(now - 14 * 60 * 1000).toISOString();
  const vlm1CompletedAt = new Date(now - 14 * 60 * 1000 + 3200).toISOString();

  db.prepare(`
    INSERT INTO event_vlm_analyses (
      id, event_id, provider, model_name, prompt_version, status,
      summary, observed_target_type, observed_action, observed_direction, observed_taxiway,
      runway_entry_observed, risk_assessment, confidence, recommended_action,
      limitations_json, evidence_json,
      queued_at, started_at, completed_at, processing_time_ms, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    vlm1Id, ev1.id, 'mock', 'RIWS-Mock-VLM-v1.0', 'riws-v1', 'COMPLETED',
    '影像分析確認地面服務車輛（VEH-001）已越越聯絡道 1N 進入跑道保護區域，方向為由西向東。依據移動軌跡研判，目標可能與預定降落航班發生衝突，風險等級極高。建議立即通知塔台並啟動跑道中斷程序。',
    '地面服務車輛',
    '目標已進入跑道保護區域',
    '由西向東',
    '1N',
    'YES', 'CRITICAL', 0.95,
    '1. 立即通知塔台執行跑道中斷程序\n2. 廣播所有航空器暫停降落\n3. 派遣地面管制員至現場確認',
    JSON.stringify(['本分析基於靜態影像，動態行為推斷可能存在誤差', '夜間條件下辨識精度下降約 15-25%']),
    JSON.stringify(['目標形態特徵與地面服務車輛一致（信心度 95%）', '邊界框定位於聯絡道 1N 跑道保護區域邊緣', '目標質心已超越跑道邊界標線']),
    vlm1CreatedAt, vlm1CreatedAt, vlm1CompletedAt, 3200, vlm1CreatedAt, vlm1CompletedAt
  );

  db.prepare('UPDATE events SET latest_vlm_analysis_id=? WHERE id=?').run(vlm1Id, ev1.id);

  eventService.addTimeline(ev1.id, {
    action_type: 'VLM_COMPLETED',
    description: 'VLM 分析完成：風險評估 CRITICAL',
    source_type: 'VLM',
    occurred_at: vlm1CompletedAt,
    metadata: { analysisId: vlm1Id, risk_assessment: 'CRITICAL' },
  });

  console.log(`[SEED] Event 1 created: ${ev1.event_code}`);

  // ── Event 2: YELLOW, ACKNOWLEDGED, 2N, unauthorized approach (VEH-002, CAM-02) ──
  console.log('[SEED] Creating Event 2: YELLOW unauthorized approach 2N...');
  const { event: ev2 } = eventService.createEvent({
    event_type: 'UNAUTHORIZED_APPROACH',
    severity: 'YELLOW',
    taxiway_id: '2N',
    target_id: 'VEH-002',
    target_type: 'VEHICLE',
    camera_id: 'CAM-02',
    confidence: 0.88,
    authorization_state: 'UNAUTHORIZED',
    stm_state: 'ACTIVE',
    runway_state: 'ON',
    taxiway_state_at_detection: 'GUARDED',
    detected_at: new Date(now - 45 * 60 * 1000).toISOString(),
  });

  db.prepare(`UPDATE events SET status='ACKNOWLEDGED', acknowledged_at=?, operator_name='ATC-01', updated_at=? WHERE id=?`)
    .run(new Date(now - 43 * 60 * 1000).toISOString(), new Date(now - 43 * 60 * 1000).toISOString(), ev2.id);

  eventService.addTimeline(ev2.id, {
    action_type: 'EVENT_ACKNOWLEDGED',
    description: '事件已由操作員 ATC-01 確認',
    source_type: 'OPERATOR',
    operator_name: 'ATC-01',
    occurred_at: new Date(now - 43 * 60 * 1000).toISOString(),
  });

  eventService.addTimeline(ev2.id, {
    action_type: 'RADIO_CONTACT',
    description: '管制員已透過無線電聯繫 VEH-002 駕駛員，告知其返回停機區',
    source_type: 'OPERATOR',
    operator_name: 'ATC-01',
    occurred_at: new Date(now - 42 * 60 * 1000).toISOString(),
  });

  // Generate media for Event 2
  const media2 = mediaGeneratorService.generateEventMedia(ev2);
  media2.forEach((record) => {
    eventService.addMedia(ev2.id, {
      media_type: record.mediaType,
      file_name: record.fileName,
      file_path: record.filePath,
      camera_id: 'CAM-02',
      captured_at: record.capturedAt,
    });
  });

  console.log(`[SEED] Event 2 created: ${ev2.event_code}`);

  // ── Event 3: RED, ACKNOWLEDGED, 3S, PERSON incursion (PER-001, CAM-04) ──
  console.log('[SEED] Creating Event 3: RED incursion 3S PERSON...');
  const { event: ev3 } = eventService.createEvent({
    event_type: 'RUNWAY_INCURSION',
    severity: 'RED',
    taxiway_id: '3S',
    target_id: 'PER-001',
    target_type: 'PERSON',
    camera_id: 'CAM-04',
    confidence: 0.82,
    authorization_state: 'UNAUTHORIZED',
    stm_state: 'ACTIVE',
    runway_state: 'ON',
    taxiway_state_at_detection: 'GUARDED',
    detected_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
  });

  db.prepare(`UPDATE events SET status='ACKNOWLEDGED', acknowledged_at=?, operator_name='ATC-02', updated_at=? WHERE id=?`)
    .run(new Date(now - 2 * 60 * 60 * 1000 + 90000).toISOString(), new Date(now - 2 * 60 * 60 * 1000 + 90000).toISOString(), ev3.id);

  eventService.addTimeline(ev3.id, {
    action_type: 'DETECTION_CONFIRMED',
    description: '人員 PER-001 進入跑道保護區域，聯絡道 3S',
    source_type: 'AI',
    occurred_at: new Date(now - 2 * 60 * 60 * 1000 + 2000).toISOString(),
  });
  eventService.addTimeline(ev3.id, {
    action_type: 'EVENT_ACKNOWLEDGED',
    description: '事件已由操作員 ATC-02 確認',
    source_type: 'OPERATOR',
    operator_name: 'ATC-02',
    occurred_at: new Date(now - 2 * 60 * 60 * 1000 + 90000).toISOString(),
  });

  // Generate media for Event 3
  const media3 = mediaGeneratorService.generateEventMedia(ev3);
  media3.forEach((record) => {
    eventService.addMedia(ev3.id, {
      media_type: record.mediaType,
      file_name: record.fileName,
      file_path: record.filePath,
      camera_id: 'CAM-04',
      captured_at: record.capturedAt,
    });
  });

  // VLM Analysis for Event 3 (COMPLETED)
  const vlm3Id = uuidv4();
  const vlm3CreatedAt = new Date(now - 2 * 60 * 60 * 1000 + 5000).toISOString();
  const vlm3CompletedAt = new Date(now - 2 * 60 * 60 * 1000 + 8000).toISOString();

  db.prepare(`
    INSERT INTO event_vlm_analyses (
      id, event_id, provider, model_name, prompt_version, status,
      summary, observed_target_type, observed_action, observed_direction, observed_taxiway,
      runway_entry_observed, risk_assessment, confidence, recommended_action,
      limitations_json, evidence_json,
      queued_at, started_at, completed_at, processing_time_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vlm3Id, ev3.id, 'mock', 'RIWS-Mock-VLM-v1.0', 'riws-v1', 'COMPLETED',
    '影像分析確認地勤人員（PER-001）已進入聯絡道 3S 跑道保護區域，穿著反光背心，步行速度約 5 km/h，方向由南向北。',
    '地勤人員',
    '目標已進入跑道保護區域',
    '由南向北',
    '3S',
    'YES', 'CRITICAL', 0.82,
    '1. 立即廣播通知相關人員 2. 確認 PER-001 身份及授權狀態 3. 啟動緊急疏散程序',
    JSON.stringify(['人員辨識在複雜背景下準確率可能降低']),
    JSON.stringify(['目標形態特徵與地勤人員一致', '未偵測到授權識別標誌', '邊界框位於聯絡道 3S 保護區內']),
    vlm3CreatedAt, vlm3CreatedAt, vlm3CompletedAt, 3000, vlm3CreatedAt, vlm3CompletedAt
  );

  db.prepare('UPDATE events SET latest_vlm_analysis_id=? WHERE id=?').run(vlm3Id, ev3.id);

  console.log(`[SEED] Event 3 created: ${ev3.event_code}`);

  // ── Event 4: YELLOW, ACKNOWLEDGED, CAMERA_FAULT, CAM-02 ──────────────────
  console.log('[SEED] Creating Event 4: CAMERA_FAULT...');
  const { event: ev4 } = eventService.createEvent({
    event_type: 'CAMERA_FAULT',
    severity: 'YELLOW',
    camera_id: 'CAM-02',
    stm_state: 'ACTIVE',
    runway_state: 'ON',
    detected_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
  });

  db.prepare(`UPDATE events SET status='ACKNOWLEDGED', acknowledged_at=?, operator_name='TECH-01', updated_at=? WHERE id=?`)
    .run(new Date(now - 3 * 60 * 60 * 1000 + 300000).toISOString(), new Date(now - 3 * 60 * 60 * 1000 + 300000).toISOString(), ev4.id);

  eventService.addTimeline(ev4.id, {
    action_type: 'CAMERA_FAULT_DETECTED',
    description: 'CAM-02 影像串流中斷，連線逾時',
    source_type: 'DEVICE',
    occurred_at: new Date(now - 3 * 60 * 60 * 1000 + 1000).toISOString(),
    metadata: { camera_id: 'CAM-02', error: 'STREAM_TIMEOUT' },
  });
  eventService.addTimeline(ev4.id, {
    action_type: 'EVENT_ACKNOWLEDGED',
    description: '技術人員 TECH-01 確認攝影機異常',
    source_type: 'OPERATOR',
    operator_name: 'TECH-01',
    occurred_at: new Date(now - 3 * 60 * 60 * 1000 + 300000).toISOString(),
  });

  console.log(`[SEED] Event 4 created: ${ev4.event_code}`);

  // ── Event 5: YELLOW, CLOSED, 4N, monitoring warning ──────────────────────
  console.log('[SEED] Creating Event 5: YELLOW CLOSED 4N...');
  const { event: ev5 } = eventService.createEvent({
    event_type: 'UNAUTHORIZED_APPROACH',
    severity: 'YELLOW',
    taxiway_id: '4N',
    target_id: 'VEH-004',
    target_type: 'VEHICLE',
    camera_id: 'CAM-05',
    confidence: 0.79,
    authorization_state: 'UNAUTHORIZED',
    stm_state: 'ACTIVE',
    runway_state: 'ON',
    taxiway_state_at_detection: 'GUARDED',
    detected_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
  });

  db.prepare(`UPDATE events SET status='CLOSED', acknowledged_at=?, closed_at=?, operator_name='ATC-01', resolution_note='車輛已確認為授權維修作業，已補充授權文件並恢復正常運作。', updated_at=? WHERE id=?`)
    .run(
      new Date(now - 5 * 60 * 60 * 1000 + 120000).toISOString(),
      new Date(now - 4 * 60 * 60 * 1000).toISOString(),
      new Date(now - 4 * 60 * 60 * 1000).toISOString(),
      ev5.id
    );

  eventService.addTimeline(ev5.id, {
    action_type: 'EVENT_CLOSED',
    description: '事件已關閉：確認為授權作業，已補充文件',
    source_type: 'OPERATOR',
    operator_name: 'ATC-01',
    occurred_at: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
  });

  console.log(`[SEED] Event 5 created: ${ev5.event_code}`);

  // ── Event 6: RED, CLOSED, 4S, completed incursion (VEH-003, CAM-05) ──────
  console.log('[SEED] Creating Event 6: RED CLOSED 4S incursion...');
  const { event: ev6 } = eventService.createEvent({
    event_type: 'RUNWAY_INCURSION',
    severity: 'RED',
    taxiway_id: '4S',
    target_id: 'VEH-003',
    target_type: 'VEHICLE',
    camera_id: 'CAM-05',
    confidence: 0.91,
    authorization_state: 'UNAUTHORIZED',
    stm_state: 'ACTIVE',
    runway_state: 'ON',
    taxiway_state_at_detection: 'GUARDED',
    detected_at: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
  });

  db.prepare(`UPDATE events SET status='CLOSED', acknowledged_at=?, closed_at=?, operator_name='ATC-02', resolution_note='事件已完整調查。車輛駕駛員誤入，已接受安全教育訓練並完成事故報告。聯絡道 4S 已恢復正常運作。', updated_at=? WHERE id=?`)
    .run(
      new Date(now - 8 * 60 * 60 * 1000 + 180000).toISOString(),
      new Date(now - 7 * 60 * 60 * 1000).toISOString(),
      new Date(now - 7 * 60 * 60 * 1000).toISOString(),
      ev6.id
    );

  eventService.addTimeline(ev6.id, {
    action_type: 'DETECTION_CONFIRMED',
    description: 'VEH-003 確認越越 4S 聯絡道進入跑道',
    source_type: 'AI',
    occurred_at: new Date(now - 8 * 60 * 60 * 1000 + 2000).toISOString(),
  });
  eventService.addTimeline(ev6.id, {
    action_type: 'INCURSION_LATCHED',
    description: '聯絡道 4S 鎖定為 INCURSION_LATCHED',
    source_type: 'SYSTEM',
    occurred_at: new Date(now - 8 * 60 * 60 * 1000 + 3000).toISOString(),
  });
  eventService.addTimeline(ev6.id, {
    action_type: 'TAXIWAY_RESET',
    description: '操作員 ATC-02 執行人工復歸，聯絡道 4S 恢復 GUARDED',
    source_type: 'OPERATOR',
    operator_name: 'ATC-02',
    occurred_at: new Date(now - 7 * 60 * 60 * 1000 + 1800000).toISOString(),
  });
  eventService.addTimeline(ev6.id, {
    action_type: 'EVENT_CLOSED',
    description: '事件完成調查並關閉',
    source_type: 'OPERATOR',
    operator_name: 'ATC-02',
    occurred_at: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
  });

  // Generate media for Event 6
  const media6 = mediaGeneratorService.generateEventMedia(ev6);
  media6.forEach((record) => {
    eventService.addMedia(ev6.id, {
      media_type: record.mediaType,
      file_name: record.fileName,
      file_path: record.filePath,
      camera_id: 'CAM-05',
      captured_at: record.capturedAt,
    });
  });

  // VLM Analysis for Event 6 (COMPLETED)
  const vlm6Id = uuidv4();
  const vlm6CreatedAt = new Date(now - 8 * 60 * 60 * 1000 + 5000).toISOString();
  const vlm6CompletedAt = new Date(now - 8 * 60 * 60 * 1000 + 8500).toISOString();

  db.prepare(`
    INSERT INTO event_vlm_analyses (
      id, event_id, provider, model_name, prompt_version, status,
      summary, observed_target_type, observed_action, observed_direction, observed_taxiway,
      runway_entry_observed, risk_assessment, confidence, recommended_action,
      limitations_json, evidence_json,
      queued_at, started_at, completed_at, processing_time_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vlm6Id, ev6.id, 'mock', 'RIWS-Mock-VLM-v1.0', 'riws-v1', 'COMPLETED',
    '影像分析確認地面服務車輛 VEH-003（工程卡車）已完整穿越聯絡道 4S 進入跑道活動區域，方向由東向西。目標已停止於跑道中央，構成嚴重飛安威脅。',
    '地面服務工程卡車',
    '目標已進入跑道並停止於跑道中央',
    '由東向西',
    '4S',
    'YES', 'CRITICAL', 0.91,
    '1. 立即啟動跑道中斷並廣播 2. 要求所有降落航班重飛 3. 派遣地面人員引導車輛離開跑道',
    JSON.stringify(['夜間影像品質影響辨識精度']),
    JSON.stringify(['車輛已完全進入跑道活動區', '停車位置位於跑道中心線附近', '未偵測到有效授權標誌']),
    vlm6CreatedAt, vlm6CreatedAt, vlm6CompletedAt, 3500, vlm6CreatedAt, vlm6CompletedAt
  );

  db.prepare('UPDATE events SET latest_vlm_analysis_id=? WHERE id=?').run(vlm6Id, ev6.id);

  console.log(`[SEED] Event 6 created: ${ev6.event_code}`);

  console.log('\n[SEED] ✓ Seed completed successfully!');
  console.log(`[SEED] Created 6 events with timelines, media, and VLM analyses.`);
  console.log(`[SEED] Events: ${ev1.event_code}, ${ev2.event_code}, ${ev3.event_code}, ${ev4.event_code}, ${ev5.event_code}, ${ev6.event_code}`);

  process.exit(0);
}

seed().catch((err) => {
  console.error('[SEED] Error:', err);
  process.exit(1);
});
