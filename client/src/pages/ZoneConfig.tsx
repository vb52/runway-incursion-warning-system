// 偵測區域設定 — merged detector settings + zone calibration page. Used to be
// two pages (DetectorConfig.tsx owning AI/motion/manual detection + the
// always-running <video>, ZoneConfig.tsx owning zone drawing/editing on its
// own separate calibration <video>) — merged into one at the operator's
// request ("整合到偵測區域設定") so there's a single place for both, instead
// of the same Z1/Z2/Z3 zones and their live judgment being split across two
// screens. This page is now the one Layout.tsx always keeps mounted (see its
// comment) — its AI/motion/manual detection setInterval loops must keep
// running when the operator navigates to another page, the same requirement
// DetectorConfig.tsx used to satisfy alone.
//
// 核心是「示範影片 + 三種獨立的『飛機出現』偵測來源」，都會呼叫 POST
// /api/demo/detect（跟 AirportSimPanel 觸發偵測的方式相同）對
// video_trigger_taxiway_id 這條聯絡道觸發偵測，並自動把跑道保護撥到警戒狀態
// RUNWAY_ALERT_DURATION_MS 秒（見 armRunwayAlert）。三種來源共用同一個
// TRIGGER_COOLDOWN_MS 節流（reportPlaneDetected），不管哪個來源觸發都算——但
// 這只節流「要不要真的送一次 /api/demo/detect」，AI 跟 Motion 這兩個持續性的
// 來源（每個 tick 都會重新判斷畫面上有沒有東西）只要那一幀還看到飛機/動態，
// 就會不受節流限制直接呼叫 armRunwayAlert() 重置警戒倒數——不然節流期間
// armRunwayAlert 不會被呼叫，警戒視窗可能在飛機明明還在畫面上時就先到期。
// 手動標記是離散事件（只有跨過標記時間點那一瞬間），沒有這個「持續看得到」
// 的概念，所以維持跟著 reportPlaneDetected 的節流一起觸發。
//
//   1. AI 物件偵測：TensorFlow.js + COCO-SSD（Google 預訓練的通用物件偵測
//      模型，跑在瀏覽器端）辨識 class === 'airplane'。不是機場監視器畫面訓練
//      的專用模型，遠距離/小畫面的飛機不一定測得到——「AI 目前看到」debug 清單
//      會列出模型每個 tick 實際看到的所有類別跟分數，方便判斷是完全沒測到還是
//      誤判成別的東西。
//   2. 動態偵測（Motion）：簡單的逐幀差異比對，裁切到操作員在下方畫出的一或
//      多個「偵測區域」（config.motion_zones，Z1/Z2/Z3...）；每個區域各自獨立
//      比對、各自對應自己的 taxiway_id，例如 Z1 框住某個聯絡道口、Z2 框住另一
//      個，各自觸發各自的滑行道，不像 AI/手動標記共用同一個「觸發聯絡道」下拉
//      選單，再縮小到 MOTION_SAMPLE_W x MOTION_SAMPLE_H 比對像素差異量，概念上
//      對應 RIWS-POC 桌面版用 cv2.createBackgroundSubtractorMOG2() 補捉 YOLO
//      漏掉的角度。不特別分辨「是不是飛機」，區域內任何明顯移動都算，所以框選
//      範圍很重要——沒有設定任何區域就完全不會掃描（不會退回掃整個畫面），框住
//      跑道/聯絡道口才準確。有獨立開關可以整個關掉。
//   3. 操作員手動標記：影片播放到飛機出現的畫面時按「標記目前畫面有飛機」，
//      記錄當下秒數（video_trigger_seconds，存在 config 裡，兩個自動偵測都
//      測不到時的保底手段）。之後每次循環播放到那個時間點（±TRIGGER_
//      TOLERANCE_S 秒）就會自動觸發一次，同一次循環內同一個標記只觸發一次。
//
// Zone/Mask 網頁編輯器沒有 UI：那原本是要給 RIWS-POC 的 YOLOv8 桌面版當
// 「自動跑道警戒」的偵測範圍用，資料還留著（RIWS-POC 透過 riws_bridge.py 的
// fetch_config()/push_config() 還在讀寫），只是這頁不提供編輯介面。
//
// 資料流向：這頁 <-> GET/PUT /api/detector/config <->
// server/src/services/DetectorConfigService.ts <-> RIWS-POC/src/riws_bridge.py
//
// 影片播放位置/速度透過 useVideoSync（Socket.IO 相對於
// server/src/services/VideoSyncService.ts）跟「主戰情表」頁面
// （client/src/components/VideoFeed.tsx）同步——在任一頁調整速度或拖曳進度條，
// 兩邊都會跟著動。偵測/觸發邏輯只在這一頁跑，避免兩個頁面同時開著時觸發兩次。
// <video> 元素本身、播放位置/速度不受 RESET（LiveMonitor.tsx handleFullReset）
// 影響——RESET 從沒碰過它。但 RESET 現在會呼叫 detectorAlertService.clear()
// 立即結束目前的警戒倒數，並短暫（見 DetectorAlertService.ts）忽略新的 arm()
// 請求，因為 AI/Motion 偵測迴圈不管在哪一頁都持續在背景跑，若沒有這個緩衝，
// RESET 當下畫面上如果還看得到飛機，下一個 tick 就會立刻重新警戒，操作員永遠
// 看不到「乾淨」的重置結果。
//
// 跑道警戒倒數（armRunwayAlert）也是伺服器端狀態（server/src/services/
// DetectorAlertService.ts），不是這頁自己算自己的 setTimeout——這樣「主戰情表」
// 才能顯示同一個倒數，而不是只有觸發偵測的那個分頁看得到。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  AlertTriangle, Crosshair, Frame, Loader2, Pencil, Plane, Play, Plus, RefreshCw, RotateCcw, Save, Trash2,
} from 'lucide-react';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { detectorApi, demoApi } from '../services/api';
import { DetectorConfig, DetectorMotionZone, DetectorRect, ALL_TAXIWAY_IDS, TaxiwayId } from '../types';
import { useVideoSync, getLastProgrammaticSeekAt } from '../hooks/useVideoSync';
import { useDetectorAlert } from '../hooks/useDetectorAlert';
import { getSocket } from '../services/socketService';
import { setDetectorVideoElement } from '../services/detectorVideoRegistry';
import { useAppStore } from '../stores/appStore';
import {
  applyRunwayStateUpdate, broadcastSnapshot, resetGeneration, getCurrentGenerationId, getTiming,
  computeCanIssueIncursionAlert, buildAlertEventId, isAlertShown, isAlertDismissed, recordServerEventCorrelation,
  type AiDetectionSnapshot, type AiDetectionEventType, type SystemStatus, type RunwayAlertArmState, type AlertGateState,
} from '../stores/aiDetectionStateStore';
import { hasPlayedAlert } from '../services/AudioController';

// Only the TensorFlow.js/COCO-SSD object-detection loop's own interval — a
// separate, independent detection source (see "1. AI object detection"
// below) that never touches the aircraft event/animation state machine, only
// the real-time safety-alert pipeline (reportPlaneDetected). Unrelated to
// AI_DETECTION_INTERVAL_MS below, which paces the Z1/Z2/Z3 motion pipeline
// that actually IS the aircraft event state machine's sole input.
const DETECT_INTERVAL_MS = 500;
// Lowered from 0.5 — COCO-SSD is a general-purpose model, not trained on
// airport surveillance footage, and a distant/small airplane in a wide CCTV
// shot often scores lower than a close-up photo would. If AI still misses
// real planes, check the "AI 目前看到" debug list: it shows ALL classes
// COCO-SSD sees each tick (not just airplane) so you can tell whether it's
// seeing nothing, or misclassifying the plane as something else — and there
// are two other detection sources (motion, manual mark) as fallbacks.
const CONFIDENCE_THRESHOLD = 0.35;
const TRIGGER_COOLDOWN_MS = 20000;
// A detection (from any of the 3 sources) arms runway protection for this
// long; another detection before it expires extends the window rather than
// stacking a second timer.
const RUNWAY_ALERT_DURATION_MS = 30000;
// Dedicated debounce for the 跑道入侵線 trigger specifically (see
// reportIncursionLineTrigger) — deliberately its own fixed 30s window,
// independent of TRIGGER_COOLDOWN_MS/playback rate: operator request is a
// real-time 30s "only fire once" window, not scaled by video speed. Applies
// regardless of whether the alert itself later gets manually cleared —
// lastIncursionTriggerAtRef is only ever reset by RESET/seek, never by
// clearAlert(), so a cleared alert still can't be immediately re-triggered.
const INCURSION_LINE_TRIGGER_COOLDOWN_MS = 30000;
// Motion detection: downscaled frame-diff sample size (perf). The
// fraction-of-pixels-changed threshold that counts as "something moved" is
// adjustable at runtime (config.motion_threshold, persisted) — it was a
// fixed 0.02 originally and turned out to fire too easily (compression
// noise/small background movement), so it's a live slider now instead of
// another guess at a magic number.
const MOTION_SAMPLE_W = 160;
const MOTION_SAMPLE_H = 90;
// Manual marks: timeupdate fires a few times a second, not every frame — a
// small window around each marked second so a mark isn't missed.
const TRIGGER_TOLERANCE_S = 0.35;
// Cadence of the Z1/Z2/Z3 "AI 判讀" pass (see runDetectionTick) — the SOLE
// producer of the AircraftEventSnapshot the aircraft event state machine
// consumes. Fixed at once per second per spec, independent of video
// playback rate. Not to be confused with DETECT_INTERVAL_MS (the separate
// TensorFlow AI object-detection loop, which never touches the event/
// animation state machine).
const AI_DETECTION_INTERVAL_MS = 1000;

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function normalizeRect(x1: number, y1: number, x2: number, y2: number): DetectorRect {
  return {
    x1: Math.round(Math.min(x1, x2)),
    y1: Math.round(Math.min(y1, y2)),
    x2: Math.round(Math.max(x1, x2)),
    y2: Math.round(Math.max(y1, y2)),
  };
}

// Cycled by index so each zone's overlay rect/label is visually distinct.
const ZONE_COLORS = ['#00c8ff', '#ff9f1c', '#c792ea', '#00ff88', '#ff6b6b', '#ffd93d'];

// Z1/Z2/Z3 carry fixed operational meaning (operator-assigned convention,
// not derived from anything) — the same飛機一次通過的三個階段：Z1 進入聯絡道
// -> Z2 在跑道頭等待 -> Z3 起飛. The tick loop's activeAircraftEventsRef
// state machine below keys off these exact zone ids (matched by object
// identity per taxiway) to track ONE event per taxiway, which AirportSimPanel.
// spawnAtTaxiway then just plays back — see that function's comment. Any
// zone beyond Z3 has no special meaning — "如果有新的就比照辦理" — new zones
// just work as plain detection regions (same drawing/edit/delete flow), they
// just don't get a phase label chip or any special AirportSimPanel behavior
// until that mapping is extended.
const ZONE_PHASE_LABELS: Record<string, string> = {
  Z1: '進入聯絡道',
  Z2: '跑道頭等待',
  Z3: '起飛',
};

// First 'Z<n>' not already in use — stable even after zones in the middle
// of the list are deleted.
function nextZoneId(zones: DetectorMotionZone[]): string {
  const used = new Set(zones.map((z) => z.id));
  let n = 1;
  while (used.has(`Z${n}`)) n++;
  return `Z${n}`;
}

// ── 飛機事件狀態機（Event-Based，每條聯絡道最多兩個並行事件）───────────────
// Strict, forward-only per-taxiway state machine, driven exclusively by
// processAircraftEventSnapshot (the sole state-mutating function — see
// below) consuming one AircraftEventSnapshot per AI 判讀 pass. Every plane
// on screen MUST be created by a real Z1 rising edge; Z2 may only advance
// that SAME plane into the runway-head-entry animation; Z3 is the
// highest-priority signal — a single valid tick (no confirm-window, no
// precondition on how far the event has gotten) commits the event to
// TAKING_OFF immediately, overriding whatever Z1/Z2 would otherwise say.
// States only ever move forward through this list, never back, and each
// transition is one-shot (see enteringAnimationStarted/
// takeoffAnimationStarted) so a signal sustained across many ticks — or a
// stale/duplicate one arriving late — can never replay an animation or
// re-derive a transition that already happened.
//
//   WAITING_FOR_Z2        — Z1 created this event; plays the stage-1
//                            "進入聯絡道" animation once, then genuinely
//                            idles (no timer/fallback advances it). Only a
//                            real Z2 (-> ENTERING_RUNWAY_HEAD) or Z3
//                            (-> TAKING_OFF) ever moves it onward.
//   ENTERING_RUNWAY_HEAD  — Z2 fired once; plays the stage-2 "進入跑道頭
//                            等待" animation once. A repeat Z2 hit here is a
//                            pure no-op.
//   HOLDING_AT_RUNWAY_HEAD— AirportSimPanel reported the stage-2 animation
//                            actually reached the runway head
//                            (entryAnimationCompleted). Frozen indefinitely;
//                            nothing but Z3 ever moves it onward.
//   TAKING_OFF            — Z3 fired (from ANY prior state). Plays the real
//                            takeoff animation once. Removed from tracking
//                            entirely once AirportSimPanel reports the
//                            takeoff animation finished ('sim:aircraft-
//                            departed', see the listener below) — that's
//                            "COMPLETED" in spec terms.
//
// UP TO TWO concurrent events per taxiway — a new Z1 rising edge may only
// create a second one once EVERY existing event for this taxiway has
// already reached TAKING_OFF (checked AFTER Z3 is processed this same
// pass, so a same-pass "Z3 confirms the existing plane is departing AND Z1
// detects a new one" combo is honored as two different planes, not
// blocked). Before that point, a repeat Z1 hit is entirely ignored — it
// neither creates a new event nor affects the existing one. See
// processAircraftEventSnapshot's blocking check.
type AircraftEventState =
  | 'WAITING_FOR_Z2' | 'ENTERING_RUNWAY_HEAD' | 'HOLDING_AT_RUNWAY_HEAD' | 'TAKING_OFF';

const AIRCRAFT_STATE_LABELS: Record<AircraftEventState, string> = {
  WAITING_FOR_Z2: '等待Z2進入跑道頭',
  ENTERING_RUNWAY_HEAD: '前往跑道頭',
  HOLDING_AT_RUNWAY_HEAD: '跑道頭等待',
  TAKING_OFF: '起飛',
};

// Monotonically increasing, unique across the whole page (not per-taxiway) —
// gives every event a stable id passed through to
// AirportSimPanel.spawnAtTaxiway (see emitSpawn) so it can dedup/target by
// identity instead of only by phase/timing heuristics.
let eventIdCounter = 0;

// Held in activeAircraftEventsRef as Map<taxiwayId, AircraftEvent[]> (see
// that ref's declaration) — at most ONE entry per taxiway (array shape kept
// only so "no active event" is a uniform empty array), see
// AircraftEventState's comment. entryAnimationCompleted is NOT decided in
// this file — it's reported back by AirportSimPanel via
// 'sim:aircraft-at-runway-head' once the tracked vehicle's OWN animation
// actually reaches the runway-head position, since that's real animation-
// timing knowledge only that component has. It only gates the NORMAL
// (non-Z3-preempted) transition into HOLDING_AT_RUNWAY_HEAD — Z3 does not
// wait on it at all. enteringAnimationStarted/takeoffAnimationStarted are
// one-shot guards: once true, that transition/spawn-command can never fire
// again for this event, regardless of how many more ticks the triggering
// zone stays hit.
interface AircraftEvent {
  id: string;
  state: AircraftEventState;
  entryAnimationCompleted: boolean;
  enteringAnimationStarted: boolean;
  takeoffAnimationStarted: boolean;
}

// ── AI 判讀 Snapshot ──────────────────────────────────────────────────────
// Raw per-taxiway Z1/Z2/Z3 judgment for a SINGLE AI analysis pass (see
// runDetectionTick) — deliberately kept separate from AircraftEvent (the
// derived, persistent state machine). Rebuilt fresh every
// AI_DETECTION_INTERVAL_MS; never itself mutated after creation, and never
// itself cancels/reverts an already-created AircraftEvent just because the
// next pass's motion reads false again — only rising edges, processed by
// processAircraftEventSnapshot, ever change event state.
interface ZoneJudgment {
  z1Motion: boolean;
  z2Motion: boolean;
  z3Triggered: boolean;
  confidence: number; // raw frame-diff score behind this pass's judgment
}

// One complete AI analysis pass, across every taxiway — the SOLE input to
// processAircraftEventSnapshot, and the SOLE source of what "偵測區域設定"
// displays as the current AI 判讀狀況, so the two can never show/use
// different data. analysisRequestId/analysisTimestamp identify which pass
// produced a given result — used to make sure a superseded (e.g.
// seek-invalidated) pass's result can never be applied after a newer one.
interface AircraftEventSnapshot {
  analysisRequestId: number;
  analysisTimestamp: number;
  taxiways: Map<string, ZoneJudgment>;
}

// Per-event debug fields shown in the debug panel below.
interface AircraftEventDebug {
  state: AircraftEventState;
  entryAnimationCompleted: boolean;
  eventReason: string;
}

// Debug snapshot of the last AI 判讀 pass's judgment AND its effect on the
// event state machine for one taxiway — surfaced in the debug panel below.
// z1Motion/z2Motion/z3Triggered/analysisTimestamp are read directly off the
// same AircraftEventSnapshot processAircraftEventSnapshot consumed (never
// separately recomputed), so this panel can never show a different reading
// than what actually drove the animation. `events` holds up to two entries
// — see activeAircraftEventsRef's comment on the concurrency cap.
interface RunwayDebugSnapshot {
  analysisTimestamp: number;
  motionScore: number;
  motionThreshold: number;
  z1Motion: boolean;
  z2Motion: boolean;
  z3Triggered: boolean;
  transitioned: boolean;
  currentAnimation: string;
  events: AircraftEventDebug[];
  // The exact AiDetectionSnapshot just published to aiDetectionStateStore
  // for this taxiway this pass — surfaced so the debug panel can show
  // eventId/sequence/generationId/source/status/decision alongside the
  // Local UI/Server round-trip latency (see aiDetectionStateStore's
  // getTiming), all read from the SAME store LiveMonitor subscribes to.
  aiSnapshot: AiDetectionSnapshot | null;
  // ── Incursion-alert Gate + dedup debug (see computeCanIssueIncursionAlert
  // and buildAlertEventId in aiDetectionStateStore.ts) ────────────────────
  systemStatus: SystemStatus;
  monitoringEnabled: boolean;
  runwayAlertState: RunwayAlertArmState;
  canIssueIncursionAlert: boolean;
  // The stable aircraft-event id (or synthetic incursion-line-only
  // placeholder) this pass's alertEventId, if any, was built from.
  aircraftEventId: string | null;
  // Only set when this pass's eventType is genuinely 'INCURSION' — the
  // composed generationId:aircraftEventId:taxiwayId:alertType string.
  alertEventId: string | null;
  alertAlreadyShown: boolean;
  alertSoundAlreadyPlayed: boolean;
  alertDismissed: boolean;
  serverIncursionLatched: boolean;
  // Human-readable reason no NEW alert fired this pass — 'ALERT_ISSUED' when
  // one legitimately did. Read directly off the same decision this pass
  // already made, never separately re-derived.
  noAlertReason: string;
}

// Below this, a native `seeking` event is treated as useVideoSync's own
// routine drift correction, not a real seek — see handleVideoSeeking's
// comment. Comfortably above both that hook's own correction threshold
// (~0.15s) and lastVideoTimeRef's staleness margin (timeupdate fires a few
// times a second), while staying well below any real seek/loop-wrap jump.
const SMALL_SEEK_IGNORE_S = 2;

// Per-zone 動態偵測門檻 override — a shared threshold calibrated for one
// zone can leave a busier one (e.g. background traffic) firing on noise, so
// each zone/the incursion line can opt into its own value instead of always
// using DetectorConfig.motion_threshold. Unchecked = no override (uses the
// shared default); checking it seeds the slider with that same default as a
// starting point rather than an arbitrary number.
function ZoneThresholdControl({
  value, defaultValue, onChange,
}: { value?: number; defaultValue: number; onChange: (v: number | undefined) => void }) {
  const isCustom = value !== undefined;
  return (
    <div className="flex items-center gap-1.5">
      <label className="flex items-center gap-1 text-[10px] text-gray-600 cursor-pointer whitespace-nowrap">
        <input
          type="checkbox"
          checked={isCustom}
          onChange={(e) => onChange(e.target.checked ? defaultValue : undefined)}
          className="accent-current"
        />
        自訂門檻
      </label>
      {isCustom && (
        <>
          <input
            type="range"
            min={0.01}
            max={0.3}
            step={0.01}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="w-16 h-1 accent-cyan-400 cursor-pointer"
          />
          <span className="font-mono text-[10px] text-gray-500 w-7 text-right">{(value * 100).toFixed(0)}%</span>
        </>
      )}
    </div>
  );
}

// Live 狀態/閥值 readout for one zone — score/threshold come straight from
// the SAME tick that drives real judgment (zoneScores, see runDetectionTick
// below), not a separate approximate scan — so this always matches exactly
// what the detection loop itself just saw. Green + filled once score crosses
// threshold — "this would fire right now".
function ZoneScoreBadge({ score, threshold }: { score: number | undefined; threshold: number }) {
  const s = score ?? 0;
  const hit = s >= threshold;
  return (
    <span
      className="font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 whitespace-nowrap"
      style={hit
        ? { borderColor: '#00ff88', background: 'rgba(0,255,136,0.15)', color: '#00ff88' }
        : { borderColor: '#374151', background: 'transparent', color: '#6b7280' }}
      title="即時動態分數 / 觸發門檻"
    >
      {(s * 100).toFixed(1)}% / {(threshold * 100).toFixed(0)}%
    </span>
  );
}

export function ZoneConfigPage() {
  const [config, setConfig] = useState<DetectorConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AirportSimPanel's "LIVE" toggle, lifted to the shared AppStore so it can
  // be read here too (see that store's liveEnabled comment) — real
  // detections must not auto-arm runway protection while LIVE is off. Kept
  // in a ref (not read from appState directly inside the detect loops/
  // armRunwayAlert) so a toggle flip doesn't need to be a dependency of
  // those effects/callbacks.
  const { state: appState } = useAppStore();
  const liveEnabledRef = useRef(appState.liveEnabled);
  useEffect(() => { liveEnabledRef.current = appState.liveEnabled; }, [appState.liveEnabled]);

  // ── Incursion-alert Gate inputs (see aiDetectionStateStore's module doc) ─
  // Kept in refs (not read from appState directly inside the detect
  // loops/reportIncursionLineTrigger) for the same reason as liveEnabledRef
  // above — a systemState change shouldn't need to restart those
  // effects/callbacks. systemStatusRef/runwayArmedRef mirror the server's
  // powerState/runwayProtectionState; monitoringEnabled (LIVE toggle AND the
  // video actually playing, not paused/ended) is read fresh at call time
  // since it can change moment-to-moment without a React re-render.
  const systemStatusRef = useRef<SystemStatus>('STOPPED');
  const runwayArmedRef = useRef<RunwayAlertArmState>('DISARMED');
  useEffect(() => {
    const ps = appState.systemState?.powerState;
    systemStatusRef.current = ps === 'ACTIVE' ? 'RUNNING' : ps === 'INITIALIZING' ? 'INITIALIZING' : 'STOPPED';
    runwayArmedRef.current = appState.systemState?.runwayProtectionState === 'ON' ? 'ARMED' : 'DISARMED';
  }, [appState.systemState?.powerState, appState.systemState?.runwayProtectionState]);

  // The ONE gate every incursion-warning entry point (local popup, sound,
  // backend detect call, Socket.IO broadcast) must pass — see
  // computeCanIssueIncursionAlert's comment. Deliberately does NOT gate
  // processAircraftEventSnapshot/the ground-sim animation state machine;
  // those keep updating off raw AI 判讀 regardless of whether an alert is
  // allowed to fire.
  // Exposes the raw Gate components (not just the combined boolean) so the
  // debug panel can show exactly which condition is blocking an alert, using
  // the SAME read canIssueIncursionAlertNow uses — never a separately
  // re-derived approximation.
  const getAlertGateState = useCallback((): AlertGateState => {
    const video = videoRef.current;
    const monitoringEnabled = liveEnabledRef.current
      && !!video && !video.paused && !video.ended && video.readyState >= 2;
    return {
      systemStatus: systemStatusRef.current,
      monitoringEnabled,
      runwayAlertState: runwayArmedRef.current,
    };
  }, []);

  const canIssueIncursionAlertNow = useCallback((): boolean => {
    return computeCanIssueIncursionAlert(getAlertGateState());
  }, [getAlertGateState]);

  // This page is always mounted regardless of route (see Layout.tsx), so
  // useLocation here reflects whether it's actually the visible page, not
  // whether it's mounted — used below to pause the AI model (the heaviest
  // continuous cost of the three detection sources: a TensorFlow.js
  // inference pass every DETECT_INTERVAL_MS, competing with video decode for
  // the same GPU) while nobody's looking at it. Motion detection — the
  // primary Z1/Z2/Z3 mechanism everything else this session was built
  // around — keeps running unconditionally either way.
  const location = useLocation();
  const isVisible = location.pathname === '/detector';

  // Persists a config change to the backend immediately (optimistic local
  // update first, so the UI never waits on the network). Used by the manual
  // marks and zone drawing — those cost real effort (precise dragging,
  // timing) to redo, so they must never depend on the operator remembering
  // to click "儲存" afterward; a page refresh before that click (e.g. for
  // unrelated debugging) would otherwise silently lose them. The taxiway
  // dropdown and "儲存" button stay manual-save — trivial to redo, not worth
  // the extra network chatter on every keystroke/selection.
  const persistConfig = useCallback(async (next: DetectorConfig) => {
    setConfig(next);
    try {
      const { frame_w, frame_h, zones, masks, video_trigger_taxiway_id, video_trigger_seconds, motion_zones, motion_threshold, incursion_line } = next;
      const res = await detectorApi.updateConfig({
        frame_w, frame_h, zones, masks, video_trigger_taxiway_id, video_trigger_seconds, motion_zones, motion_threshold, incursion_line,
      });
      setConfig(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '自動儲存失敗，請手動按「儲存」確認');
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await detectorApi.getConfig();
      setConfig(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);

  // ── Player (synced with LiveMonitor's VideoFeed via useVideoSync) ───────
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null); // AI bounding-box overlay
  const { publish, debug: syncDebug } = useVideoSync(videoRef);

  // Registers this <video> as the one LiveMonitor's VideoFeed mirrors via
  // canvas instead of decoding its own second copy of the same source — see
  // detectorVideoRegistry.ts. This page's video is the one that must always
  // keep decoding (detection depends on it), so it's the natural single
  // source of truth for any other page that just wants to display the feed.
  //
  // Callback ref, not a useEffect(() => ..., []) on videoRef.current: the
  // <video> element only exists once `config` has loaded (see the `if
  // (!config) return ...` below) — the first commit renders a loading
  // placeholder with no <video> in the tree at all. An effect with an empty
  // dep array fires once against THAT tree, captures null, and never runs
  // again once the real element mounts a moment later, leaving every other
  // page's mirror permanently pointed at nothing. A callback ref fires
  // exactly when the node actually attaches/detaches, so it can't miss the
  // later mount (or race it) the way effect timing can.
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    setDetectorVideoElement(el);
  }, []);
  // Playback speed is fixed at 1x (operator request: 影片播放速度訂死在正常，
  // 不要加快) — no UI to change it. playbackRate/playbackRateRef are kept
  // (rather than ripping out every RUNWAY_ALERT_DURATION_MS/playbackRateRef.
  // current scaling call site) since dividing by a constant 1 is a correct,
  // harmless no-op; this is just the single place that constant comes from.
  const [playbackRate] = useState(1);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
  // Read by armRunwayAlert to scale RUNWAY_ALERT_DURATION_MS with playback
  // speed (kept in a ref, not read from state directly, so a speed change
  // doesn't need to be a dependency of the detection effects/armRunwayAlert).
  const playbackRateRef = useRef(playbackRate);
  useEffect(() => { playbackRateRef.current = playbackRate; }, [playbackRate]);

  const seek = (t: number) => {
    setCurrentTime(t);
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      // Always publish 1 — see playbackRate's comment above.
      publish(1, t);
    }
  };

  // ── Shared trigger plumbing (all 3 detection sources funnel through this) ─
  const modelRef = useRef<cocoSsd.ObjectDetection | null>(null);
  // Date.now() ms of the last trigger, per cooldown key — motion zones use
  // their own zone.id as the key (see reportPlaneDetected) so Z1/Z2/Z3 don't
  // throttle each other: they represent a single plane's Z1(進入聯絡道) ->
  // Z2(跑道頭等待) -> Z3(起飛) progression firing in quick succession, which
  // a single shared cooldown would mostly swallow after the first zone.
  // AI/manual (no zone id) share the fixed key 'default'.
  const lastTriggerAtRef = useRef<Map<string, number>>(new Map());
  // Kept in a ref (not read from `config` inside the detect loops) so a
  // config edit elsewhere on this page doesn't restart the loops.
  const taxiwayIdRef = useRef('1S');

  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [lastDetection, setLastDetection] = useState<{ score: number; at: string; source: string } | null>(null);
  // "AI 判讀現況" — a human-readable read of what the motion zones currently
  // say is happening on the field. Kept until the next zone hit rather than
  // clearing every tick nothing fires — motion sampling is intermittent even
  // for continuous real motion, so clearing on every quiet tick would just
  // flicker.
  const [currentStatus, setCurrentStatus] = useState<{ label: string; taxiwayId: string; at: number } | null>(null);
  const [triggerCount, setTriggerCount] = useState(0);
  const [rawPredictions, setRawPredictions] = useState<cocoSsd.DetectedObject[]>([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [motionLevel, setMotionLevel] = useState(0);
  // config.motion_threshold, not local state — persisted (see
  // DetectorConfigService's DEFAULT_CONFIG for the 0.06 default). Read inside
  // the tick's setInterval closure via a ref so it doesn't need to be a
  // dependency of the detection effect.
  const motionThresholdRef = useRef(0.06);
  useEffect(() => {
    if (config) motionThresholdRef.current = config.motion_threshold;
  }, [config?.motion_threshold]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (config) taxiwayIdRef.current = config.video_trigger_taxiway_id;
  }, [config?.video_trigger_taxiway_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Runway auto-alert window ─────────────────────────────────────────
  // Server-owned (DetectorAlertService) so LiveMonitor's VideoFeed shows the
  // same countdown, not just whichever tab happened to arm it — see
  // useDetectorAlert. armRunwayAlert just tells the server to (re)arm.
  const alertUntil = useDetectorAlert();
  const alertSecondsLeft = alertUntil ? Math.max(0, Math.ceil((alertUntil - nowTick) / 1000)) : 0;

  // mayCreate=false (ZoneConfig.tsx's own Z2/Z3 motion-zone hits — operator
  // request: "TRIGGER自動警戒一定要Z1觸發，只有告警觸發後Z2/Z3延長") means this
  // call may only EXTEND an alert that's already active server-side; it must
  // never start a fresh one on its own. Enforced server-side (see
  // DetectorAlertService.arm), not just by skipping the call here, since the
  // client's own alertUntil copy can lag a socket round-trip behind. AI/
  // incursion-line/manual-mark are unaffected (left at the default true) —
  // this rule is specific to the Z1/Z2/Z3 taxi-sequence zones, not every
  // detection source.
  const armRunwayAlert = useCallback(async (mayCreate = true) => {
    // 沒在LIVE的情況，不要自動切RWY ON 啟動 — gated here (the single funnel
    // point every detection source's arm request goes through, called both
    // from reportPlaneDetected and directly by the AI/motion/incursion-line
    // ticks to keep resetting the window every tick a plane's still visible)
    // rather than at each individual call site, so nothing can accidentally
    // bypass it. This reverses what was previously deliberate: the alert/RWY
    // pipeline used to run unconditionally regardless of LIVE, with LIVE only
    // gating the ground-sim projection — operator asked for this to change.
    if (!liveEnabledRef.current) return;
    // RUNWAY_ALERT_DURATION_MS is calibrated for 1x playback; scale it down
    // by the current speed so the alert window stays paced with the sped-up
    // video instead of feeling disproportionately long at e.g. 5x.
    const scaledDurationMs = RUNWAY_ALERT_DURATION_MS / playbackRateRef.current;
    await detectorApi.armAlert(scaledDurationMs, mayCreate).catch(() => {
      // Best-effort — demoApi.detect() right after this just no-ops if the
      // system still isn't ready.
    });
  }, []);

  // Common landing spot for all 3 detection sources. taxiwayId defaults to
  // the "觸發聯絡道" dropdown (AI/manual mark both trigger for the whole
  // frame) — motion detection passes the specific zone's own taxiway_id
  // instead, since each motion zone maps to a different taxiway. mayCreateAlert
  // forwards to armRunwayAlert — see that function's comment.
  const reportPlaneDetected = useCallback(async (source: string, confidence: number, taxiwayId?: string, zoneId?: string, snapshotBase64?: string, mayCreateAlert = true) => {
    // Scaled by playback speed, same as the runway alert window — otherwise
    // at e.g. 3x the cooldown (20s fixed) outlasts the alert window (10s),
    // leaving a dead zone where the runway has already gone back to
    // unarmed but new detections are still being suppressed.
    const scaledCooldownMs = TRIGGER_COOLDOWN_MS / playbackRateRef.current;
    const now = Date.now();
    const cooldownKey = zoneId ?? 'default';
    const lastAt = lastTriggerAtRef.current.get(cooldownKey) ?? 0;
    if (now - lastAt < scaledCooldownMs) return;
    lastTriggerAtRef.current.set(cooldownKey, now);
    setTriggerCount((c) => c + 1);
    setLastDetection({ score: confidence, at: new Date().toLocaleTimeString('zh-TW', { hour12: false }), source });

    const resolvedTaxiwayId = taxiwayId ?? taxiwayIdRef.current;

    // MUST be awaited before demoApi.detect fires, not run concurrently —
    // armRunwayAlert is the single gate that decides whether the system is
    // actually armed (STM ACTIVE + RWY protection ON) before demoApi.detect
    // is allowed to land; firing both at once risked demoApi.detect arriving
    // first and being silently bailed by the backend
    // (SimulationEngine.processDetection requires STM ACTIVE) while still
    // consuming this detection's cooldown slot.
    await armRunwayAlert(mayCreateAlert);
    demoApi.detect({
      taxiway_id: resolvedTaxiwayId,
      target_type: 'AIRCRAFT',
      confidence,
      entering_runway: true,
      camera_id: source,
      snapshot_base64: snapshotBase64,
    }).catch(() => {
      // Can still fail (e.g. RWY enable itself failed) — stay quiet.
    });

    // AirportSimPanel's ground-sim projection is driven separately, straight
    // out of the motion tick loop below (not from here) — it needs to know
    // which zones fired TOGETHER in the same tick (Z1+Z2/Z3 combos — see
    // AirportSimPanel.spawnAtTaxiway), which this per-zone, per-call
    // function can't see on its own.
  }, [armRunwayAlert]);

  // Date.now() ms of the last incursion-line trigger — deliberately
  // separate from lastTriggerAtRef/TRIGGER_COOLDOWN_MS (see
  // INCURSION_LINE_TRIGGER_COOLDOWN_MS's comment). Only ever reset by
  // resetTemporalDetectionState (RESET/seek/demo-reset) — clearAlert()
  // (manually dismissing the current alert) does NOT touch this, so a
  // cleared alert still can't be immediately re-triggered within the 30s
  // window.
  const lastIncursionTriggerAtRef = useRef(0);

  // Dedicated, direct trigger path for the 跑道入侵線 specifically — kept
  // separate from reportPlaneDetected (which serves the Z1/Z2/Z3/AI/manual
  // sources and their own per-zone cooldown/mayCreateAlert semantics) so
  // there's no indirection or shared state that could delay or suppress an
  // incursion-line hit: it fires the moment the line's score crosses
  // threshold, gated only by its own INCURSION_LINE_TRIGGER_COOLDOWN_MS.
  // Still awaits armRunwayAlert before demoApi.detect for the same
  // correctness reason as reportPlaneDetected (STM/RWY must actually be
  // ACTIVE by the time the backend sees the detection, or it's silently
  // dropped).
  const reportIncursionLineTrigger = useCallback(async (
    confidence: number, taxiwayId: string, snapshotBase64: string | undefined, alertEventId: string,
  ) => {
    // The Gate, re-checked HERE (not just trusted from the caller) — every
    // entry point that can create/write a real alert must pass it itself,
    // per the operator's explicit "禁止任何 callback 繞過檢查直接觸發警告".
    // The caller only ever invokes this when publishAiDetectionSnapshot's
    // own Gate-aware classification already read INCURSION, but a mid-flight
    // Gate flip (e.g. operator stops STM between that read and this async
    // call) must still be caught here.
    if (!canIssueIncursionAlertNow()) return;
    const now = Date.now();
    if (now - lastIncursionTriggerAtRef.current < INCURSION_LINE_TRIGGER_COOLDOWN_MS) return;
    lastIncursionTriggerAtRef.current = now;
    setTriggerCount((c) => c + 1);
    setLastDetection({ score: confidence, at: new Date().toLocaleTimeString('zh-TW', { hour12: false }), source: 'DETECTOR-INCURSION-LINE' });

    await armRunwayAlert();
    demoApi.detect({
      taxiway_id: taxiwayId,
      target_type: 'AIRCRAFT',
      confidence,
      entering_runway: true,
      camera_id: 'DETECTOR-INCURSION-LINE',
      snapshot_base64: snapshotBase64,
      alert_event_id: alertEventId,
    }).then((res) => {
      // Correlate the server's own event id back to OUR alertEventId so
      // useSocket.ts's onEventCreated can recognize "this is the SAME alert
      // I already showed" by exact id match instead of a recency guess —
      // see recordServerEventCorrelation's comment.
      const serverEventId = res.data?.eventId;
      if (serverEventId) recordServerEventCorrelation(serverEventId, alertEventId);
    }).catch(() => {
      // Can still fail (e.g. RWY enable itself failed) — stay quiet.
    });
  }, [armRunwayAlert, canIssueIncursionAlertNow]);

  // ── 1. AI object detection (TensorFlow.js + COCO-SSD) ───────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await tf.ready();
        const model = await cocoSsd.load(); // default base model — small + fast enough for a 500ms poll
        if (cancelled) return;
        modelRef.current = model;
        setModelStatus('ready');
      } catch {
        if (!cancelled) setModelStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const drawOverlay = useCallback((planes: cocoSsd.DetectedObject[]) => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of planes) {
      const [x, y, w, h] = p.bbox;
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#00ff88';
      ctx.font = '16px monospace';
      ctx.fillText(`airplane ${(p.score * 100).toFixed(0)}%`, x, y > 20 ? y - 6 : y + 16);
    }
  }, []);

  useEffect(() => {
    // Paused while this page isn't the visible one — see isVisible's
    // comment. Motion detection (below) is unaffected, so RWY 警戒 and the
    // ground-sim projection keep working from the background even with AI
    // paused; only AI's own detections (and its overlay boxes) pause.
    if (modelStatus !== 'ready' || !aiEnabled || !isVisible) {
      if (!aiEnabled) drawOverlay([]);
      return;
    }

    const tick = async () => {
      const video = videoRef.current;
      const model = modelRef.current;
      if (!video || !model || video.readyState < 2) return; // not enough frame data yet

      let predictions: cocoSsd.DetectedObject[];
      try {
        predictions = await model.detect(video);
      } catch {
        return; // transient decode/WebGL hiccup — skip this tick, try again next
      }

      setRawPredictions(predictions);
      const planes = predictions.filter((p) => p.class === 'airplane' && p.score >= CONFIDENCE_THRESHOLD);
      drawOverlay(planes);

      if (planes.length === 0) return;
      // Gate — rawPredictions/the overlay boxes above still update
      // regardless (that's just a visual debug aid, not an alert); only the
      // real alert/backend-detection pair below is gated.
      if (!canIssueIncursionAlertNow()) return;
      const best = planes.reduce((a, b) => (a.score > b.score ? a : b));
      // Reset the runway alert window on every tick a plane is still visible,
      // not just when reportPlaneDetected's cooldown lets a new event through
      // — otherwise the window can lapse mid-detection while a plane is
      // plainly still on screen, just because the last /api/demo/detect call
      // happened >TRIGGER_COOLDOWN_MS ago.
      armRunwayAlert();
      reportPlaneDetected('DETECTOR-VIDEO-AI', best.score);
    };

    const intervalId = setInterval(tick, DETECT_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [modelStatus, aiEnabled, isVisible, drawOverlay, reportPlaneDetected, armRunwayAlert, canIssueIncursionAlertNow]);

  // ── 2. Motion detection (frame-diff, independent of the AI model) ───────
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // One diff baseline per zone (keyed by zone id) — each zone crops a
  // different part of the frame, so they can't share a single baseline.
  const prevFramesRef = useRef<Map<string, Uint8ClampedArray>>(new Map());
  // Operator-drawn zones (config.motion_zones) — kept in a ref so the tick
  // loop doesn't need `config` as a dep (avoids restarting the detection
  // interval on every unrelated config edit).
  const motionZonesRef = useRef<DetectorMotionZone[]>([]);
  // The single 跑道入侵線 (config.incursion_line) — kept separate from
  // motionZonesRef since it's scored the same way but handled differently on
  // a hit (real snapshot, no ground-sim projection).
  const incursionLineRef = useRef<DetectorMotionZone | null>(null);
  // Up to two AircraftEvents per taxiway currently tracking a plane (see
  // AircraftEventState's comment) — the single source of truth
  // processAircraftEventSnapshot reads and mutates. All reset together
  // whenever zones are redrawn, since an event built against the old zone
  // layout isn't meaningful once the rects (and what they mean) have
  // changed.
  const activeAircraftEventsRef = useRef<Map<string, AircraftEvent[]>>(new Map());
  // Previous AI 判讀 pass's raw Z1/Z2/Z3 hit state per taxiway — rising-edge
  // detection (false -> true transition only, never "still hit") is what
  // actually drives event creation/advancement, so a signal sustained
  // across many passes fires its one relevant transition exactly once
  // instead of repeating it every pass.
  const prevZoneHitsRef = useRef<Map<string, { z1: boolean; z2: boolean; z3: boolean }>>(new Map());
  // Identifies which AI 判讀 pass produced a given result — bumped at the
  // start of every pass AND on every seek (invalidating whatever pass, if
  // any, was in flight). analysisInProgressRef guards against two passes
  // ever running concurrently (runDetectionTick is synchronous today so
  // this can't actually happen yet, but guards the invariant regardless —
  // if a scheduled pass finds one still "in progress" it skips rather than
  // overlapping).
  const analysisRequestIdRef = useRef(0);
  const analysisInProgressRef = useRef(false);
  // Monotonic per-taxiway sequence for the local-first AiDetectionSnapshot
  // published to aiDetectionStateStore each pass — see
  // publishAiDetectionSnapshot below. Incremented on EVERY publish for that
  // taxiway regardless of content change, so the store's stale-sequence
  // guard has something meaningful to compare against.
  const aiSnapshotSequenceRef = useRef<Map<string, number>>(new Map());
  // Stable eventId per taxiway for the CURRENT detection "incident" — reuses
  // the taxiway's active AircraftEvent id when the Z1/Z2/Z3 machine has one
  // (naturally correlating the ground-sim event and the AI-detection
  // snapshot for the same plane); falls back to a locally-generated id when
  // only the incursion line fired with no aircraft event tracked. Cleared on
  // reset/seek along with everything else.
  const aiSnapshotEventIdRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    motionZonesRef.current = config?.motion_zones ?? [];
    incursionLineRef.current = config?.incursion_line ?? null;
    prevFramesRef.current = new Map(); // zone set/rects changed — old baselines no longer comparable
    activeAircraftEventsRef.current = new Map();
    prevZoneHitsRef.current = new Map();
  }, [config?.motion_zones, config?.incursion_line]);

  // ── 事件判定/debug 面板顯示狀態 ────────────────────────────────────────
  const [runwayDebug, setRunwayDebug] = useState<Record<string, RunwayDebugSnapshot>>({});
  // Live 狀態/閥值 readout per zone (see ZoneScoreBadge) — populated straight
  // from runDetectionTick's own scoreByZone below, the exact same
  // measurement real judgment uses, not a separate approximate scan.
  const [zoneScores, setZoneScores] = useState<Record<string, number>>({});

  // ── 影片時間軸跳轉後重新判定 ──────────────────────────────────────────────
  // A seek (drag the seek bar, click a new time, or ANY page's currentTime =
  // assignment — see detectorVideoRegistry.ts, every page ultimately shares
  // this one <video>) invalidates every taxiway's Z1/Z2/Z3 state instantly:
  // the frame-diff baselines, the Z3 confirm streak, the pending/confirmed
  // event, and the event cooldown were all built from footage at the OLD
  // time and describe nothing about what's on screen after the jump.
  // Listened via the <video>'s own onSeeking/onSeeked props below — the
  // browser fires these for every possible cause of a jump (this page's own
  // seek(), VideoFeed.tsx's remote seek via getDetectorVideoElement(),
  // useVideoSync's catch-up correction, or the video's own `loop` wrap), so
  // there's no need to separately intercept each call site.
  const isSeekingRef = useRef(false);
  // Bumped on every `seeking` — handleVideoSeeked checks this before applying
  // its immediate post-seek analysis result, so a second seek arriving
  // before the first one's analysis finished makes the stale one's result
  // abandoned instead of racing the new one.
  const seekRequestIdRef = useRef(0);
  const [analysisStatus, setAnalysisStatus] = useState<'IDLE' | 'REANALYZING'>('IDLE');
  const [seekDebug, setSeekDebug] = useState<{ seekRequestId: number; targetTime: number } | null>(null);

  // Single reset point for every piece of per-taxiway temporal state the
  // tick loop accumulates — only clears the transient judgment state used
  // for THIS frame's decision, never the permanent event/audit records
  // (those live server-side and are untouched here).
  const resetTemporalDetectionState = useCallback(() => {
    prevFramesRef.current = new Map();          // 舊的 Motion 狀態（frame-diff baseline）
    activeAircraftEventsRef.current = new Map(); // 舊的飛機事件狀態機（每條聯絡道）
    prevZoneHitsRef.current = new Map();        // 舊的 Z1/Z2/Z3 rising-edge 追蹤
    lastTriggerAtRef.current = new Map();       // 舊的事件 Cooldown
    lastIncursionTriggerAtRef.current = 0;      // 舊的入侵線 Cooldown
    aiSnapshotSequenceRef.current = new Map();  // 舊的 AiDetectionSnapshot sequence
    aiSnapshotEventIdRef.current = new Map();   // 舊的 AiDetectionSnapshot eventId 對應
    resetGeneration();                          // 讓 LiveMonitor 端的 local-first store 也失效舊資料
    setCurrentStatus(null);                     // 舊的 Icon
    setRunwayDebug({});
  }, []);

  const handleVideoSeeking = useCallback(() => {
    // Distinguish a REAL seek (drag the bar, click a new time, or the
    // <video loop> wrap) from useVideoSync's own routine sub-second drift
    // correction (that hook sets v.currentTime = expected roughly once a
    // second whenever drift exceeds ~0.15s — normal clock jitter, buffering
    // stalls, background-tab throttling). Both fire the exact same native
    // `seeking` event, but a small drift nudge is NOT a scene change.
    // lastVideoTimeRef (updated on every timeupdate, a few times a second)
    // is a close-enough "position just before this" reference to tell the
    // two apart.
    const newTime = videoRef.current?.currentTime ?? 0;
    const jump = Math.abs(newTime - lastVideoTimeRef.current);
    if (jump < SMALL_SEEK_IGNORE_S) return;

    // useVideoSync's OWN drift correction can occasionally be LARGE (past
    // SMALL_SEEK_IGNORE_S) — e.g. right after the video sat stalled/
    // buffering for a while, "expected" (derived purely from wall-clock
    // elapsed time) can be many seconds ahead of where playback actually is
    // by the time it resumes. That correction is still not a real seek; it
    // was misclassified as one before this check existed, which wiped
    // activeAircraftEventsRef/the ground-sim vehicles moments after they'd
    // just been created — reported live as "事件產出飛機後就消失了". Treated
    // exactly like a loop wrap below: only the frame-diff baselines reset,
    // events/vehicles are left alone. getLastProgrammaticSeekAt() is tagged
    // with a timestamp (not a boolean) since the native `seeking` event
    // dispatches asynchronously — a plain flag set-then-cleared
    // synchronously around the v.currentTime assignment could clear before
    // this handler ever runs.
    const isOwnSyncCorrection = Date.now() - getLastProgrammaticSeekAt() < 500;
    if (isOwnSyncCorrection) {
      prevFramesRef.current = new Map();
      prevZoneHitsRef.current = new Map();
      return;
    }

    // <video loop> wrapping back to 0 fires this exact same native
    // `seeking` event but is NOT a real seek — the operator didn't ask to
    // jump anywhere, the demo clip is just repeating. Per the operator's
    // spec, only an actual seek (dragging the bar, clicking a new time) may
    // clear in-flight aircraft events/vehicles; a loop wrap must not
    // interrupt an in-progress Z1->Z2->takeoff sequence just because it's
    // still running when the clip happens to repeat (animations can now
    // take 30s+ end to end, so this is a real, frequent case, not a rare
    // edge case). Detected as: jumped backward, landed near the very start,
    // coming from near the very end. Only the frame-diff baselines/
    // rising-edge tracking get reset — the OLD end-of-clip frame vs the NEW
    // start-of-clip frame is a real discontinuity that must not be misread
    // as motion — activeAircraftEventsRef and the ground-sim vehicles it
    // drives are deliberately left untouched.
    const isLoopWrap = newTime < lastVideoTimeRef.current
      && newTime < SMALL_SEEK_IGNORE_S
      && (duration === 0 || lastVideoTimeRef.current > duration - SMALL_SEEK_IGNORE_S);
    if (isLoopWrap) {
      prevFramesRef.current = new Map();
      prevZoneHitsRef.current = new Map();
      return;
    }

    isSeekingRef.current = true;
    seekRequestIdRef.current += 1;
    // 讓任何仍在進行中（或已排程）的舊 AI 判讀失效，並清除舊的暫存 Snapshot
    // 狀態——見 handleVideoSeeked，新影格載入完成後會立即重新判讀一次。
    analysisRequestIdRef.current += 1;
    analysisInProgressRef.current = false;
    resetTemporalDetectionState();
    setAnalysisStatus('REANALYZING');
    // 舊的 Track 暫存狀態 — tells AirportSimPanel to drop any LIVE-tracked
    // vehicle and stop whatever animation (起飛/等待) it was mid-playing.
    getSocket().emit('detector:video-seeking');
  }, [resetTemporalDetectionState, duration]);

  // Server-broadcast when an operator explicitly resets the demo scene (see
  // DetectorAlertService.notifyDemoReset) — one of the few things allowed to
  // clear activeAircraftEventsRef. Also emits the same
  // 'detector:video-seeking' AirportSimPanel already listens for, so a demo
  // reset drops any LIVE-tracked vehicle/animation the same way a seek does.
  useEffect(() => {
    const socket = getSocket();
    const onDemoReset = () => {
      resetTemporalDetectionState();
      // RESET 時影片從頭播放 — operator request. Native onSeeking/onSeeked
      // on the <video> below will also fire from this and run their own
      // (redundant but harmless) reset/reanalysis; this call itself is what
      // actually moves playback back to 0.
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
        publish(playbackRateRef.current, 0);
      }
      socket.emit('detector:video-seeking');
    };
    socket.on('detector:demo-reset', onDemoReset);
    return () => { socket.off('detector:demo-reset', onDemoReset); };
  }, [resetTemporalDetectionState, publish]);

  // Scores one zone's rect against its own running baseline. Reuses a single
  // shared canvas across zones/ticks (sequential draws — cheap, no need for
  // one canvas per zone).
  const computeZoneScore = useCallback((video: HTMLVideoElement, zone: DetectorMotionZone): number => {
    if (!motionCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = MOTION_SAMPLE_W;
      c.height = MOTION_SAMPLE_H;
      motionCanvasRef.current = c;
    }
    const canvas = motionCanvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;

    const { rect } = zone;
    ctx.drawImage(video, rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1, 0, 0, MOTION_SAMPLE_W, MOTION_SAMPLE_H);
    const frame = ctx.getImageData(0, 0, MOTION_SAMPLE_W, MOTION_SAMPLE_H).data;

    const prev = prevFramesRef.current.get(zone.id);
    if (!prev) {
      prevFramesRef.current.set(zone.id, new Uint8ClampedArray(frame));
      return 0;
    }

    let changed = 0;
    const totalPixels = MOTION_SAMPLE_W * MOTION_SAMPLE_H;
    for (let i = 0; i < frame.length; i += 4) {
      const delta = Math.abs(frame[i] - prev[i]) + Math.abs(frame[i + 1] - prev[i + 1]) + Math.abs(frame[i + 2] - prev[i + 2]);
      if (delta > 60) changed++;
    }
    prevFramesRef.current.set(zone.id, new Uint8ClampedArray(frame));
    return changed / totalPixels;
  }, []);

  // Grabs the CURRENT full video frame as a JPEG for a 跑道入侵線 hit — real
  // evidence attached to the resulting event instead of the generated
  // placeholder. Capped at 960px wide (not the native frame) to keep the
  // JSON payload a reasonable size.
  const snapshotCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureSnapshot = useCallback((video: HTMLVideoElement): string | undefined => {
    if (!video.videoWidth) return undefined;
    if (!snapshotCanvasRef.current) snapshotCanvasRef.current = document.createElement('canvas');
    const canvas = snapshotCanvasRef.current;
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      return undefined; // e.g. tainted canvas — fail quiet, event still gets created without a snapshot
    }
  }, []);

  // Every emit carries the event's own id (see eventIdCounter) so
  // AirportSimPanel can target/dedup by identity — belt-and-suspenders
  // alongside this file's own one-shot flags (enteringAnimationStarted/
  // takeoffAnimationStarted), which already guarantee each of these fires at
  // most once per event on this side.
  const emitSpawn = useCallback((taxiwayId: string, event: 'TAKEOFF' | 'RUNWAY_HOLDING' | 'ENTERING', eventId: string) => {
    getSocket().emit('sim:spawn-at-taxiway', { taxiway_id: taxiwayId, event, event_id: eventId });
  }, []);

  // AirportSimPanel reports back once a LIVE-tracked vehicle's own animation
  // actually reaches the runway-head position — this is the only place
  // entryAnimationCompleted may become true, since only that component knows
  // when its own animation has actually finished. Matched by event_id when
  // present (AirportSimPanel threads it through from the ENTERING spawn),
  // falling back to "the one still ENTERING_RUNWAY_HEAD with
  // entryAnimationCompleted still false" for safety. Only advances state if
  // the event is still ENTERING_RUNWAY_HEAD — if Z3 already force-advanced it
  // to TAKING_OFF in the meantime, entryAnimationCompleted is still recorded
  // (useful for the debug panel) but must NOT move the state sideways/back.
  useEffect(() => {
    const socket = getSocket();
    const onArrived = (data: { taxiway_id?: string; event_id?: string }) => {
      if (typeof data?.taxiway_id !== 'string') return;
      const events = activeAircraftEventsRef.current.get(data.taxiway_id);
      const event = events?.find((e) => e.id === data.event_id)
        ?? events?.find((e) => e.state === 'ENTERING_RUNWAY_HEAD' && !e.entryAnimationCompleted);
      if (!event) return;
      event.entryAnimationCompleted = true;
      if (event.state === 'ENTERING_RUNWAY_HEAD') {
        event.state = 'HOLDING_AT_RUNWAY_HEAD';
      }
    };
    socket.on('sim:aircraft-at-runway-head', onArrived);
    return () => { socket.off('sim:aircraft-at-runway-head', onArrived); };
  }, []);

  // AirportSimPanel reports back once a LIVE-tracked vehicle's takeoff
  // animation actually completes (simState -> 'DONE') — clears this
  // taxiway's event entirely so a LATER, genuinely new Z1 detection can
  // start a fresh one instead of being permanently blocked for the rest of
  // the session (only one active event is ever allowed per taxiway — see
  // AircraftEventState's comment). Matched by event_id when present,
  // falling back to "clear whatever's TAKING_OFF" for safety. Per the
  // operator's spec, an event may only ever be removed by: this (takeoff
  // animation completing), RESET, a video seek, or a demo reset — never by
  // a timer, and never just because Z1/Z2/Z3 signals momentarily drop out.
  useEffect(() => {
    const socket = getSocket();
    const onDeparted = (data: { taxiway_id?: string; event_id?: string }) => {
      if (typeof data?.taxiway_id !== 'string') return;
      const events = activeAircraftEventsRef.current.get(data.taxiway_id);
      if (!events) return;
      const remaining = data.event_id
        ? events.filter((e) => e.id !== data.event_id)
        : events.filter((e) => e.state !== 'TAKING_OFF');
      if (remaining.length > 0) activeAircraftEventsRef.current.set(data.taxiway_id, remaining);
      else activeAircraftEventsRef.current.delete(data.taxiway_id);
    };
    socket.on('sim:aircraft-departed', onDeparted);
    return () => { socket.off('sim:aircraft-departed', onDeparted); };
  }, []);

  // ── 唯一的 Event-Based 狀態機 ────────────────────────────────────────────
  // The SOLE function allowed to create/advance/mutate AircraftEvents.
  // Everything else (detection loops, timeupdate, requestAnimationFrame,
  // React render, zone callbacks, the alarm pipeline) may only ever produce
  // an AircraftEventSnapshot and hand it to this function — never spawn a
  // plane or drive an animation directly. Pure with respect to its input
  // (only reads `snapshot` and `activeAircraftEventsRef`/`liveEnabledRef`),
  // its only side effects are mutating activeAircraftEventsRef and calling
  // emitSpawn/armRunwayAlert — both already idempotent/one-shot-guarded.
  // Priority fixed every pass: Z3 (TAKING_OFF, highest) > Z2
  // (ENTERING_RUNWAY_HEAD) > Z1 (NEW event) > none — checked in that exact
  // order so a same-pass "Z3 frees the taxiway AND Z1 fires" combo resolves
  // correctly. Returns per-taxiway debug info (did a transition happen this
  // pass, what animation is the event currently playing) so the debug panel
  // can display EXACTLY what this function used/decided, never a separately
  // recomputed reading.
  const processAircraftEventSnapshot = useCallback((snapshot: AircraftEventSnapshot) => {
    const results = new Map<string, { transitioned: boolean; currentAnimation: string }>();
    for (const [taxiwayId, judgment] of snapshot.taxiways) {
      let transitioned = false;
      const prevHits = prevZoneHitsRef.current.get(taxiwayId) ?? { z1: false, z2: false, z3: false };
      const z1Rising = judgment.z1Motion && !prevHits.z1;
      const z2Rising = judgment.z2Motion && !prevHits.z2;
      const z3Rising = judgment.z3Triggered && !prevHits.z3;
      prevZoneHitsRef.current.set(taxiwayId, { z1: judgment.z1Motion, z2: judgment.z2Motion, z3: judgment.z3Triggered });

      // The entire event state machine freezes while LIVE is off — mirrors
      // AirportSimPanel.spawnAtTaxiway's own LIVE gate exactly, so the two
      // sides can never desync (an event advancing here with no vehicle on
      // screen to reflect it, since AirportSimPanel would silently drop the
      // spawn command — this is what previously let an event get
      // permanently stuck at WAITING_FOR_Z2 with no plane ever appearing if
      // LIVE happened to be off at the moment Z1 first fired).
      if (liveEnabledRef.current) {
        // 1) Z3 — highest priority. Preempts everything, from ANY state,
        // the instant it fires — no confirm-window, no precondition on how
        // far the event has gotten (not even entryAnimationCompleted).
        if (z3Rising) {
          for (const event of activeAircraftEventsRef.current.get(taxiwayId) ?? []) {
            if (event.state !== 'TAKING_OFF' && !event.takeoffAnimationStarted) {
              event.state = 'TAKING_OFF';
              event.takeoffAnimationStarted = true;
              transitioned = true;
              emitSpawn(taxiwayId, 'TAKEOFF', event.id);
            }
          }
        }

        // 2) Z2 — only ever affects the event still WAITING_FOR_Z2 (the
        // SAME plane Z1 created). A repeat Z2 hit afterward, or one with no
        // such event, is a pure no-op.
        if (z2Rising) {
          const event = (activeAircraftEventsRef.current.get(taxiwayId) ?? [])
            .find((e) => e.state === 'WAITING_FOR_Z2');
          if (event && !event.enteringAnimationStarted) {
            event.state = 'ENTERING_RUNWAY_HEAD';
            event.enteringAnimationStarted = true;
            transitioned = true;
            emitSpawn(taxiwayId, 'RUNWAY_HOLDING', event.id);
          }
        }

        // 3) Z1 — only ever creates a brand-new event; never touches an
        // existing one. Blocked while this taxiway has any tracked event
        // that HASN'T (yet) reached TAKING_OFF — checked AFTER Z3 above has
        // already run this same pass, so a same-pass "Z3 confirms the
        // existing plane is now departing AND Z1 detects a new one" combo is
        // honored as two different planes (跑道上有人正在起飛，但同時偵測到
        // 另一架新的進入聯絡道) rather than blocked just because the
        // departing one's entry hasn't been removed from tracking yet (that
        // only happens once its takeoff animation actually finishes — see
        // the 'sim:aircraft-departed' listener). Z2/Z3 can never create a
        // plane on their own (no event to act on when this branch hasn't
        // run yet).
        let justCreated: AircraftEvent | undefined;
        if (z1Rising) {
          const existingEvents = activeAircraftEventsRef.current.get(taxiwayId) ?? [];
          const blocked = existingEvents.some((e) => e.state !== 'TAKING_OFF');
          if (!blocked) {
            justCreated = {
              id: `evt-${++eventIdCounter}`,
              state: 'WAITING_FOR_Z2',
              entryAnimationCompleted: false,
              enteringAnimationStarted: false,
              takeoffAnimationStarted: false,
            };
            activeAircraftEventsRef.current.set(taxiwayId, [...existingEvents, justCreated]);
            transitioned = true;
            emitSpawn(taxiwayId, 'ENTERING', justCreated.id);
          }
        }

        // If Z1 just created a brand-new event THIS SAME pass, a same-pass
        // Z2/Z3 rising edge still needs to apply to it — the Z2/Z3 checks
        // above ran BEFORE this event existed, so they had nothing to act
        // on and became no-ops. Without this, zones that sit physically
        // close together (all crossed in the same real-time sample) would
        // permanently strand the event at WAITING_FOR_Z2: rising-edge
        // detection means Z2/Z3 won't fire again once already `true`, so a
        // signal that stays continuously true from here on would never
        // give the event a second chance to advance. Still respects Z3 >
        // Z2 priority for this same new event.
        if (justCreated) {
          if (z3Rising) {
            justCreated.state = 'TAKING_OFF';
            justCreated.takeoffAnimationStarted = true;
            transitioned = true;
            emitSpawn(taxiwayId, 'TAKEOFF', justCreated.id);
          } else if (z2Rising) {
            justCreated.state = 'ENTERING_RUNWAY_HEAD';
            justCreated.enteringAnimationStarted = true;
            transitioned = true;
            emitSpawn(taxiwayId, 'RUNWAY_HOLDING', justCreated.id);
          }
        }
      }

      const events = activeAircraftEventsRef.current.get(taxiwayId) ?? [];

      // 只要有進行中的事件（尚未起飛），就持續延長告警 — intentionally
      // decoupled from the state transitions above: only ever reads the
      // (already-updated) event list, never gates or affects it.
      // armRunwayAlert already self-gates on LIVE, so no double-check
      // needed here. mayCreate=false — this may never START a fresh alert
      // on its own; only 跑道入侵線 (reportIncursionLineTrigger) may.
      if (events.some((e) => e.state !== 'TAKING_OFF')) {
        armRunwayAlert(false);
      }

      // Up to two events may be tracked — show whichever is furthest along.
      const rank = (s: AircraftEventState) => s === 'TAKING_OFF' ? 4
        : s === 'HOLDING_AT_RUNWAY_HEAD' ? 3
        : s === 'ENTERING_RUNWAY_HEAD' ? 2
        : 1; // WAITING_FOR_Z2
      const furthest = events.reduce<AircraftEvent | null>(
        (best, e) => (!best || rank(e.state) > rank(best.state) ? e : best), null
      );
      results.set(taxiwayId, {
        transitioned,
        currentAnimation: furthest
          ? AIRCRAFT_STATE_LABELS[furthest.state]
          : (liveEnabledRef.current ? 'NO_ACTIVE_EVENT' : 'LIVE_OFF'),
      });
    }
    return results;
  }, [emitSpawn, armRunwayAlert]);

  // ── Local-first publish to aiDetectionStateStore ───────────────────────
  // Called once per taxiway, every AI 判讀 pass, immediately after
  // processAircraftEventSnapshot — this is the "發布Snapshot到前端共享Store"
  // step of the operator's Local-first + Server Reconciliation spec.
  // LiveMonitor (and any other subscriber) sees this the instant it's
  // called, no network round trip. incursionLatched is a LOCAL prediction
  // mirroring SimulationEngine.processDetection's own authorization check
  // (any real signal this pass + taxiway not currently AUTHORIZED per the
  // client's own already-synced systemState) — the server's later
  // 'taxiway:state-updated' broadcast is what actually confirms/corrects it
  // (see reconcileFromServerTaxiwayState in useSocket.ts).
  const publishAiDetectionSnapshot = useCallback((
    taxiwayId: string,
    judgment: { z1Motion: boolean; z2Motion: boolean; z3Triggered: boolean; confidence: number },
    events: AircraftEvent[],
    incursionLineHit: boolean,
    analyzedAt: number,
    canIssueIncursionAlert: boolean,
  ) => {
    const furthest = events.reduce<AircraftEvent | null>((best, e) => {
      const rank = (s: AircraftEventState) => s === 'TAKING_OFF' ? 4 : s === 'HOLDING_AT_RUNWAY_HEAD' ? 3 : s === 'ENTERING_RUNWAY_HEAD' ? 2 : 1;
      return !best || rank(e.state) > rank(best.state) ? e : best;
    }, null);

    // The Gate (canIssueIncursionAlert) ONLY controls whether a real
    // incursion-line hit is ever CLASSIFIED as an alert-worthy INCURSION —
    // it never touches the Z1/Z2/Z3-driven branches below, so aircraft-
    // event/animation status (AIRCRAFT_DETECTED/ENTERING_RUNWAY/TAKEOFF)
    // keeps updating normally off raw AI 判讀 even while the Gate is closed.
    let eventType: AiDetectionEventType = 'NONE';
    if (incursionLineHit && canIssueIncursionAlert) eventType = 'INCURSION';
    else if (furthest?.state === 'TAKING_OFF') eventType = 'TAKEOFF';
    else if (furthest?.state === 'ENTERING_RUNWAY_HEAD' || furthest?.state === 'HOLDING_AT_RUNWAY_HEAD') eventType = 'ENTERING_RUNWAY';
    else if (furthest) eventType = 'AIRCRAFT_DETECTED';

    const authState = appState.systemState?.taxiways.find((t) => t.id === taxiwayId)?.state;
    // Only a real, Gate-approved INCURSION classification on an unauthorized
    // taxiway may ever latch locally — NOT merely "some aircraft event
    // exists here" (that was a pre-existing bug: any Z1-created event on an
    // unauthorized taxiway read as incursionLatched immediately, long before
    // anything actually crossed the incursion line).
    const incursionLatched = eventType === 'INCURSION' && authState !== 'AUTHORIZED';

    if (eventType === 'NONE') {
      aiSnapshotEventIdRef.current.delete(taxiwayId);
    } else if (!aiSnapshotEventIdRef.current.has(taxiwayId)) {
      // Reuse the tracked AircraftEvent's own id when one exists (naturally
      // correlates the ground-sim event and this snapshot for the same
      // plane); otherwise (incursion-line-only, no Z1/Z2/Z3 event) mint a
      // dedicated local id. Held stable for as long as this taxiway's
      // eventType stays active — cleared above once it returns to NONE. This
      // is the "aircraftEventId" segment of alertEventId below.
      aiSnapshotEventIdRef.current.set(taxiwayId, furthest?.id ?? `local-incursion-${taxiwayId}-${analyzedAt}`);
    }
    const aircraftEventId = aiSnapshotEventIdRef.current.get(taxiwayId) ?? `local-none-${taxiwayId}`;

    // alertEventId = generationId + aircraftEventId + taxiwayId + alertType
    // (see buildAlertEventId) — the ONE id shared end-to-end by this alert
    // instance, only ever constructed when this pass is genuinely INCURSION.
    // Stable for as long as aircraftEventId/generationId don't change, so
    // re-publishing the same ongoing incident (or the Gate flapping open/
    // closed/open while the underlying condition never actually cleared)
    // always reproduces the SAME string — which is exactly what lets
    // aiDetectionStateStore's shownAlertIds/dismissedAlertIds dedup work.
    // The other eventTypes aren't alerts, so they just reuse aircraftEventId
    // directly — no alert-identity scheme needed for plain status.
    const eventId = eventType === 'INCURSION'
      ? buildAlertEventId(getCurrentGenerationId(), aircraftEventId, taxiwayId, 'RUNWAY_INCURSION')
      : aircraftEventId;

    const sequence = (aiSnapshotSequenceRef.current.get(taxiwayId) ?? -1) + 1;
    aiSnapshotSequenceRef.current.set(taxiwayId, sequence);

    const zoneSnapshot = (motion: boolean, confidence: number) => ({ motion, triggered: motion, confidence });
    const snapshot: AiDetectionSnapshot = {
      eventId,
      taxiwayId: taxiwayId as TaxiwayId,
      sequence,
      generationId: getCurrentGenerationId(),
      analyzedAt,
      videoTime: videoRef.current?.currentTime ?? 0,
      source: 'LOCAL_AI',
      status: 'PENDING_SERVER',
      zones: {
        Z1: zoneSnapshot(judgment.z1Motion, judgment.z1Motion ? judgment.confidence : 0),
        Z2: zoneSnapshot(judgment.z2Motion, judgment.z2Motion ? judgment.confidence : 0),
        Z3: zoneSnapshot(judgment.z3Triggered, judgment.z3Triggered ? judgment.confidence : 0),
      },
      decision: { eventType, incursionLatched },
    };

    applyRunwayStateUpdate(snapshot);
    broadcastSnapshot(snapshot);
    return snapshot;
  }, [appState.systemState]);

  // ── AI 判讀 pass ─────────────────────────────────────────────────────────
  // Once per AI_DETECTION_INTERVAL_MS (1s): sample every zone, build ONE
  // AircraftEventSnapshot, use it to update the "偵測區域設定" display, then
  // hand that EXACT SAME snapshot to processAircraftEventSnapshot — the two
  // can never show/use different data because there is only one snapshot
  // object and no separately recomputed reading anywhere. Guarded against
  // overlap (analysisInProgressRef) and staleness (analysisRequestIdRef) —
  // today's implementation is fully synchronous so neither can actually
  // trigger mid-pass, but both are real safety nets: overlap-guard for if
  // this ever becomes genuinely async, staleness-guard for a seek arriving
  // and superseding whatever pass was current.
  const runDetectionTick = useCallback(() => {
      if (analysisInProgressRef.current) return; // previous pass still "running" — skip, don't overlap
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const zones = motionZonesRef.current;
      const incursionLine = incursionLineRef.current;
      if (zones.length === 0 && !incursionLine) {
        setMotionLevel(0);
        return; // nothing configured to scan
      }

      analysisInProgressRef.current = true;
      const requestId = ++analysisRequestIdRef.current;
      try {
        // Computed ONCE per pass so every taxiway/zone this tick sees the
        // exact same Gate reading — see computeCanIssueIncursionAlert's
        // comment. Only ever gates whether an incursion-line hit may be
        // CLASSIFIED as an alert (and, downstream, actually reported to the
        // backend) — never the Z1/Z2/Z3 event/animation machine below.
        const gateState = getAlertGateState();
        const gateOpen = computeCanIssueIncursionAlert(gateState);
        let maxScore = 0;
        // Zones that hit threshold THIS pass — keyed by object identity (a
        // Set), not zone.id, since two different taxiways can each have
        // their own zone reusing the label 'Z1'/'Z2'/'Z3'.
        const hitZones = new Set<DetectorMotionZone>();
        // Raw score per zone this pass — feeds both the debug panel and the
        // live ZoneScoreBadge readouts below.
        const scoreByZone = new Map<DetectorMotionZone, number>();
        for (const zone of zones) {
          const score = computeZoneScore(video, zone);
          scoreByZone.set(zone, score);
          if (score > maxScore) maxScore = score;
          // Per-zone threshold override (zone.threshold) falls back to the
          // shared default — see DetectorMotionZone's comment.
          if (score >= (zone.threshold ?? motionThresholdRef.current)) {
            // Z1/Z2/Z3 are taxiway-tracking zones for the ground-sim event
            // machine, NOT the safety-incursion trigger — they only ever
            // touch the 跑道警戒 (runway alert) countdown, never the actual
            // incursion-detection pipeline (demoApi.detect, via
            // reportPlaneDetected). Only the 跑道入侵線 (see
            // reportIncursionLineTrigger below) may ever report a real
            // detection that can latch INCURSION. Within the countdown
            // itself: only Z1 may START a fresh window (mayCreate=true);
            // Z2/Z3 may only EXTEND one that's already running — a plane
            // visibly still taxiing keeps the window alive, but entering Z2/
            // Z3 alone (without Z1 or the incursion line ever having armed
            // anything) must not start one from nothing.
            armRunwayAlert(zone.id === 'Z1');
            hitZones.add(zone);
          }
        }

        // ── 組成本次 AI 判讀的統一 Snapshot ────────────────────────────────
        const zonesByTaxiway = new Map<string, DetectorMotionZone[]>();
        for (const zone of zones) {
          const list = zonesByTaxiway.get(zone.taxiway_id) ?? [];
          list.push(zone);
          zonesByTaxiway.set(zone.taxiway_id, list);
        }
        const zoneInfoByTaxiway = new Map<string, { z1zone?: DetectorMotionZone; z2zone?: DetectorMotionZone; z3zone?: DetectorMotionZone }>();
        const snapshot: AircraftEventSnapshot = {
          analysisRequestId: requestId,
          analysisTimestamp: Date.now(),
          taxiways: new Map(),
        };
        for (const [taxiwayId, taxiwayZones] of zonesByTaxiway) {
          const z1zone = taxiwayZones.find((z) => z.id === 'Z1');
          const z2zone = taxiwayZones.find((z) => z.id === 'Z2');
          const z3zone = taxiwayZones.find((z) => z.id === 'Z3');
          zoneInfoByTaxiway.set(taxiwayId, { z1zone, z2zone, z3zone });
          snapshot.taxiways.set(taxiwayId, {
            z1Motion: !!z1zone && hitZones.has(z1zone),
            z2Motion: !!z2zone && hitZones.has(z2zone),
            z3Triggered: !!z3zone && hitZones.has(z3zone),
            confidence: z3zone ? (scoreByZone.get(z3zone) ?? 0) : (z1zone ? scoreByZone.get(z1zone) ?? 0 : 0),
          });
        }

        // 這次判讀若已被更新的（例如 seek 觸發的）請求取代，放棄套用結果——
        // 舊的非同步判讀結果不得覆蓋新結果。
        if (requestId !== analysisRequestIdRef.current) return;

        // ── 跑道入侵線 ── scored here (once — computeZoneScore mutates its
        // baseline, so it must never be sampled twice in one pass) so both
        // the trigger below AND the per-taxiway publish loop further down
        // can use the same result. Never feeds the ground-sim projection
        // (that's Z1/Z2/Z3's job); this is a real safety trigger, so it
        // always grabs a snapshot of the actual frame instead. Backend
        // already checks the taxiway's real authorization state and only
        // latches INCURSION_LATCHED if it wasn't authorized — no separate
        // check needed here, crossing the line just reports "something
        // crossed" the same way any zone does. Goes through its own direct
        // reportIncursionLineTrigger, not the shared reportPlaneDetected —
        // operator request: immediate, undelayed, with its own 30s debounce
        // (INCURSION_LINE_TRIGGER_COOLDOWN_MS) independent of Z1/Z2/Z3's.
        // The actual reportIncursionLineTrigger call is deferred to the
        // per-taxiway loop below (after processAircraftEventSnapshot), so it
        // can use that taxiway's freshly-published alertEventId (published.
        // eventId) instead of re-deriving one here — one composition point,
        // not two.
        let incursionLineHit = false;
        let incursionLineConfidence = 0;
        let incursionLineSnapshotBase64: string | undefined;
        if (incursionLine) {
          const score = computeZoneScore(video, incursionLine);
          scoreByZone.set(incursionLine, score);
          if (score > maxScore) maxScore = score;
          if (score >= (incursionLine.threshold ?? motionThresholdRef.current)) {
            incursionLineHit = true;
            incursionLineConfidence = Math.min(0.95, 0.5 + score * 10);
            incursionLineSnapshotBase64 = captureSnapshot(video);
          }
        }

        // ── 交給唯一的事件狀態機判定 ────────────────────────────────────────
        const results = processAircraftEventSnapshot(snapshot);

        // ── 用同一份 snapshot + 狀態機處理結果組出 debug 面板，兩邊資料完全
        // 同源，不會有「畫面顯示 false 但動畫卻自己觸發」的分歧。同一個迴圈裡
        // 也立即 publishAiDetectionSnapshot——LiveMonitor 用的資料跟這裡顯示
        // 的 AI 判讀現況是同一份，不是分開算兩次 ──────────────────────────
        let bestLabel: string | null = null;
        let bestTaxiway: string | null = null;
        let bestRank = -1;
        const nextDebug: Record<string, RunwayDebugSnapshot> = {};
        for (const [taxiwayId, judgment] of snapshot.taxiways) {
          const { z3zone } = zoneInfoByTaxiway.get(taxiwayId)!;
          const result = results.get(taxiwayId)!;
          const events = activeAircraftEventsRef.current.get(taxiwayId) ?? [];
          const taxiwayIncursionLineHit = incursionLineHit && incursionLine?.taxiway_id === taxiwayId;
          const published = publishAiDetectionSnapshot(taxiwayId, judgment, events, taxiwayIncursionLineHit, snapshot.analysisTimestamp, gateOpen);
          // Only actually report to the backend when publishAiDetectionSnapshot
          // itself classified this pass as a real, Gate-approved INCURSION —
          // that classification is the single source of truth (mirrors
          // exactly what the local popup/sound dedup keys off), so this can
          // never fire when the Gate was closed even if the raw line hit is
          // true. published.eventId IS the alertEventId in that case (see
          // publishAiDetectionSnapshot's comment).
          if (taxiwayIncursionLineHit && published.decision.eventType === 'INCURSION') {
            reportIncursionLineTrigger(incursionLineConfidence, taxiwayId, incursionLineSnapshotBase64, published.eventId);
          }

          // ── Gate/dedup debug — read directly off the SAME decision this
          // pass already made (published.decision, gateState), never a
          // separately re-derived approximation, so this panel can never
          // show a reason that disagrees with what actually happened above.
          const isAlertPass = published.decision.eventType === 'INCURSION';
          const alertEventId = isAlertPass ? published.eventId : null;
          const alertAlreadyShown = alertEventId !== null && isAlertShown(taxiwayId as TaxiwayId, alertEventId);
          const alertSoundAlreadyPlayed = alertEventId !== null && hasPlayedAlert(alertEventId);
          const alertDismissed = alertEventId !== null && isAlertDismissed(taxiwayId as TaxiwayId, alertEventId);
          const serverIncursionLatched = appState.systemState?.taxiways.find((t) => t.id === taxiwayId)?.state === 'INCURSION_LATCHED';
          const noAlertReason = !taxiwayIncursionLineHit ? 'NO_INCURSION_LINE_HIT'
            : gateState.systemStatus !== 'RUNNING' ? `SYSTEM_NOT_RUNNING(${gateState.systemStatus})`
            : !gateState.monitoringEnabled ? 'MONITORING_DISABLED_OR_VIDEO_NOT_PLAYING'
            : gateState.runwayAlertState !== 'ARMED' ? 'RUNWAY_NOT_ARMED'
            : alertDismissed ? 'DISMISSED_SUPPRESSED'
            : alertAlreadyShown ? 'ALREADY_SHOWN_DEDUP'
            : 'ALERT_ISSUED';

          nextDebug[taxiwayId] = {
            analysisTimestamp: snapshot.analysisTimestamp,
            motionScore: z3zone ? (scoreByZone.get(z3zone) ?? 0) : 0,
            motionThreshold: z3zone?.threshold ?? motionThresholdRef.current,
            z1Motion: judgment.z1Motion,
            z2Motion: judgment.z2Motion,
            z3Triggered: judgment.z3Triggered,
            transitioned: result.transitioned,
            currentAnimation: result.currentAnimation,
            systemStatus: gateState.systemStatus,
            monitoringEnabled: gateState.monitoringEnabled,
            runwayAlertState: gateState.runwayAlertState,
            canIssueIncursionAlert: gateOpen,
            aircraftEventId: aiSnapshotEventIdRef.current.get(taxiwayId) ?? null,
            alertEventId,
            alertAlreadyShown,
            alertSoundAlreadyPlayed,
            alertDismissed,
            serverIncursionLatched,
            noAlertReason,
            events: events.map((event) => ({
              state: event.state,
              entryAnimationCompleted: event.entryAnimationCompleted,
              eventReason: AIRCRAFT_STATE_LABELS[event.state],
            })),
            aiSnapshot: published,
          };
          for (const event of events) {
            const rank = event.state === 'TAKING_OFF' ? 4
              : event.state === 'HOLDING_AT_RUNWAY_HEAD' ? 3
              : event.state === 'ENTERING_RUNWAY_HEAD' ? 2
              : 1; // WAITING_FOR_Z2
            if (rank > bestRank) {
              bestRank = rank;
              bestLabel = AIRCRAFT_STATE_LABELS[event.state];
              bestTaxiway = taxiwayId;
            }
          }
        }
        setRunwayDebug(nextDebug);
        if (bestLabel && bestTaxiway) {
          setCurrentStatus({ label: bestLabel, taxiwayId: bestTaxiway, at: Date.now() });
        }

        // Live per-zone score readout for ZoneScoreBadge — same measurement
        // just taken above for real judgment, keyed by zone.id for the UI.
        const nextZoneScores: Record<string, number> = {};
        for (const [zone, score] of scoreByZone) nextZoneScores[zone.id] = score;
        setZoneScores(nextZoneScores);

        setMotionLevel(maxScore);
      } finally {
        analysisInProgressRef.current = false;
      }
  }, [computeZoneScore, captureSnapshot, reportIncursionLineTrigger, armRunwayAlert, processAircraftEventSnapshot, publishAiDetectionSnapshot, getAlertGateState]);

  useEffect(() => {
    if (!motionEnabled) {
      setMotionLevel(0);
      prevFramesRef.current = new Map(); // avoid a stale-diff false trigger on re-enable
      return;
    }
    // Self-rescheduling setTimeout, not a fixed setInterval — lets the
    // actual real-time gap between passes scale down with video playback
    // rate (same pattern as RUNWAY_ALERT_DURATION_MS/TRIGGER_COOLDOWN_MS),
    // recomputed fresh via playbackRateRef.current on every reschedule
    // rather than needing to tear down/rebuild the timer on a rate change.
    // AI_DETECTION_INTERVAL_MS stays the base rate at 1x — this doesn't
    // change the "once per second" cadence the operator asked for at normal
    // speed, only how it scales when the video is sped up.
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const schedule = () => {
      const delayMs = AI_DETECTION_INTERVAL_MS / playbackRateRef.current;
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        runDetectionTick();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [motionEnabled, runDetectionTick]);

  // 影片跳轉完成、新影格已經載入後，立即執行一次 AI 判讀，不必等下一個
  // AI_DETECTION_INTERVAL_MS 週期——用的是同一個 runDetectionTick，不是另一
  // 條獨立的重新分析路徑。handleVideoSeeking 已經清空 prevFramesRef，所以這
  // 次判讀的每個區域都會先建立新的比對基準（computeZoneScore 的 cold-start
  // 行為固定回傳 0），不會把 seek 前後影格的落差誤判成 motion。
  const handleVideoSeeked = useCallback(() => {
    const requestId = seekRequestIdRef.current;
    setSeekDebug({ seekRequestId: requestId, targetTime: videoRef.current?.currentTime ?? 0 });
    runDetectionTick();
    if (seekRequestIdRef.current === requestId) {
      isSeekingRef.current = false;
      setAnalysisStatus('IDLE');
    }
  }, [runDetectionTick]);

  // ── 3. Manual marks — fires when playback crosses a marked timestamp ────
  const firedThisLoopRef = useRef<Set<number>>(new Set());
  const lastVideoTimeRef = useRef(0);

  const handleVideoTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const t = e.currentTarget.currentTime;
    setCurrentTime(t);
    // Pinned to 1x — see playbackRate's comment. Defensive against a stale
    // synced value (e.g. a leftover >1 rate from before speed control was
    // removed) rather than just trusting the element's own rate.
    if (e.currentTarget.playbackRate !== 1) e.currentTarget.playbackRate = 1;

    if (t < lastVideoTimeRef.current - 1) firedThisLoopRef.current.clear(); // `loop` wrapped back to 0
    lastVideoTimeRef.current = t;

    if (!config) return;
    for (const trigger of config.video_trigger_seconds) {
      if (Math.abs(t - trigger) <= TRIGGER_TOLERANCE_S && !firedThisLoopRef.current.has(trigger)) {
        firedThisLoopRef.current.add(trigger);
        // Gate — a scripted replay trigger is still a real alert/backend-
        // detection call, so it must pass the same Gate as every other
        // source (see canIssueIncursionAlertNow's comment).
        if (canIssueIncursionAlertNow()) reportPlaneDetected('DETECTOR-VIDEO-MANUAL', 0.95);
      }
    }
  };

  const markPlaneHere = () => {
    const video = videoRef.current;
    if (!video || !config) return;
    const t = Math.round(video.currentTime * 10) / 10;
    if (config.video_trigger_seconds.includes(t)) return;
    persistConfig({ ...config, video_trigger_seconds: [...config.video_trigger_seconds, t].sort((a, b) => a - b) });
  };

  const removeTrigger = (t: number) => {
    if (!config) return;
    persistConfig({ ...config, video_trigger_seconds: config.video_trigger_seconds.filter((s) => s !== t) });
  };

  // Manual early-clear of the runway alert window (DetectorAlertService.clear())
  // — ends it immediately instead of waiting out the countdown. Broadcasts
  // 'detector:alert-cleared' so LiveMonitor's countdown clears too.
  const clearAlert = () => {
    detectorApi.clearAlert().catch(() => {});
  };

  // Covers the one field that isn't auto-persisted (video_trigger_taxiway_id
  // — the dropdown) plus a manual "did it actually save" confirmation for
  // everything else, via the same persistConfig used by marks/region.
  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await persistConfig(config);
    } finally {
      setSaving(false);
    }
  };

  // ── Region drawing (drag a rect on the video) ────────────────────────
  const regionCanvasRef = useRef<HTMLCanvasElement>(null);
  const [drawingRegion, setDrawingRegion] = useState(false);
  // Which existing zone a redraw should overwrite, instead of creating a
  // new one — set by the ✎ button on a zone chip below. null while
  // drawingRegion is for a brand-new zone ("新增偵測區域").
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  // Drawing the single 跑道入侵線 (config.incursion_line) instead of a motion
  // zone — mutually exclusive with drawingRegion (see the button handlers
  // below, each cancels the other before starting).
  const [drawingLine, setDrawingLine] = useState(false);
  const regionDragRef = useRef<{ active: boolean; x1: number; y1: number; x2: number; y2: number }>({
    active: false, x1: 0, y1: 0, x2: 0, y2: 0,
  });

  // Keeps the region canvas's internal pixel buffer matched to the video's
  // native resolution — a drag before the canvas is sized lands nowhere near
  // where it was drawn.
  const ensureRegionCanvasSized = useCallback((): HTMLCanvasElement | null => {
    const canvas = regionCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !video.videoWidth) return null;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    return canvas;
  }, []);

  const drawRegionOverlay = useCallback(() => {
    const canvas = ensureRegionCanvasSized();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    (config?.motion_zones ?? []).forEach((zone, i) => {
      const color = ZONE_COLORS[i % ZONE_COLORS.length];
      const { rect } = zone;
      ctx.fillStyle = color + '1a'; // ~10% alpha
      ctx.fillRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1);
      ctx.fillStyle = color;
      ctx.font = '14px monospace';
      const label = ZONE_PHASE_LABELS[zone.id] ? `${zone.id} · ${ZONE_PHASE_LABELS[zone.id]} · ${zone.taxiway_id}` : `${zone.id} · ${zone.taxiway_id}`;
      ctx.fillText(label, rect.x1 + 4, rect.y1 > 16 ? rect.y1 - 4 : rect.y1 + 16);
    });

    // 跑道入侵線 — drawn distinctly (solid red, dashed) from motion zones so
    // it reads as the safety boundary it is, not just another zone.
    if (config?.incursion_line) {
      const { rect } = config.incursion_line;
      ctx.fillStyle = 'rgba(255,68,68,0.12)';
      ctx.fillRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1);
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1);
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff4444';
      ctx.font = 'bold 14px monospace';
      ctx.fillText(`入侵線 · ${config.incursion_line.taxiway_id}`, rect.x1 + 4, rect.y1 > 16 ? rect.y1 - 4 : rect.y1 + 16);
    }

    if (regionDragRef.current.active) {
      const drag = normalizeRect(regionDragRef.current.x1, regionDragRef.current.y1, regionDragRef.current.x2, regionDragRef.current.y2);
      ctx.fillStyle = drawingLine ? 'rgba(255,68,68,0.15)' : 'rgba(255,255,255,0.15)';
      ctx.fillRect(drag.x1, drag.y1, drag.x2 - drag.x1, drag.y2 - drag.y1);
      ctx.strokeStyle = drawingLine ? '#ff4444' : '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(drag.x1, drag.y1, drag.x2 - drag.x1, drag.y2 - drag.y1);
    }
  }, [config?.motion_zones, config?.incursion_line, drawingLine, ensureRegionCanvasSized]);

  useEffect(() => { drawRegionOverlay(); }, [drawRegionOverlay]);

  const regionCanvasPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = ensureRegionCanvasSized() ?? regionCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const onRegionMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRegion && !drawingLine) return;
    const { x, y } = regionCanvasPos(e);
    regionDragRef.current = { active: true, x1: x, y1: y, x2: x, y2: y };
  };

  const onRegionMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!regionDragRef.current.active) return;
    const { x, y } = regionCanvasPos(e);
    regionDragRef.current.x2 = x;
    regionDragRef.current.y2 = y;
    drawRegionOverlay();
  };

  const onRegionMouseUp = () => {
    if (!regionDragRef.current.active || !config) return;
    regionDragRef.current.active = false;
    const r = normalizeRect(regionDragRef.current.x1, regionDragRef.current.y1, regionDragRef.current.x2, regionDragRef.current.y2);
    if (r.x2 - r.x1 < 8 || r.y2 - r.y1 < 8) {
      drawRegionOverlay(); // ignore accidental clicks/tiny drags
      return;
    }
    if (drawingLine) {
      // Keeps the existing taxiway mapping when redrawing, defaults to the
      // "觸發聯絡道" dropdown's value the first time it's drawn.
      persistConfig({
        ...config,
        incursion_line: { id: 'LINE', rect: r, taxiway_id: config.incursion_line?.taxiway_id ?? config.video_trigger_taxiway_id },
      });
      setDrawingLine(false);
      return;
    }
    if (editingZoneId) {
      // Redraw an existing zone's rect in place — keeps its id and
      // taxiway_id (and therefore its Z1/Z2/Z3 phase meaning) unchanged.
      persistConfig({
        ...config,
        motion_zones: config.motion_zones.map((z) => (z.id === editingZoneId ? { ...z, rect: r } : z)),
      });
    } else {
      const newZone: DetectorMotionZone = {
        id: nextZoneId(config.motion_zones),
        rect: r,
        taxiway_id: config.video_trigger_taxiway_id,
      };
      persistConfig({ ...config, motion_zones: [...config.motion_zones, newZone] });
    }
    setDrawingRegion(false);
    setEditingZoneId(null);
  };

  const removeMotionZone = (zoneId: string) => {
    if (!config) return;
    persistConfig({ ...config, motion_zones: config.motion_zones.filter((z) => z.id !== zoneId) });
  };

  const setMotionZoneTaxiway = (zoneId: string, taxiwayId: string) => {
    if (!config) return;
    persistConfig({
      ...config,
      motion_zones: config.motion_zones.map((z) => (z.id === zoneId ? { ...z, taxiway_id: taxiwayId } : z)),
    });
  };

  // undefined clears the override (zone goes back to using the shared
  // 動態偵測門檻 default) — see DetectorMotionZone.threshold's comment on
  // why a per-zone override exists.
  const setMotionZoneThreshold = (zoneId: string, threshold: number | undefined) => {
    if (!config) return;
    persistConfig({
      ...config,
      motion_zones: config.motion_zones.map((z) => (z.id === zoneId ? { ...z, threshold } : z)),
    });
  };

  const removeIncursionLine = () => {
    if (!config) return;
    persistConfig({ ...config, incursion_line: null });
  };

  const setIncursionLineTaxiway = (taxiwayId: string) => {
    if (!config || !config.incursion_line) return;
    persistConfig({ ...config, incursion_line: { ...config.incursion_line, taxiway_id: taxiwayId } });
  };

  const setIncursionLineThreshold = (threshold: number | undefined) => {
    if (!config || !config.incursion_line) return;
    persistConfig({ ...config, incursion_line: { ...config.incursion_line, threshold } });
  };

  if (loading) {
    return <div className="p-6 text-gray-400 text-sm">載入偵測區域設定中...</div>;
  }
  if (!config) {
    return <div className="p-6 text-red-400 text-sm">{error ?? '無法載入設定'}</div>;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Frame className="w-5 h-5 text-cyan-400" />
            偵測區域設定
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Zone Config — 示範影片來源、AI / 動態 / 手動三重偵測，跟 Z1/Z2/Z3 動態偵測區域框選/校準都在這頁
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearAlert}
            disabled={alertSecondsLeft === 0}
            title="立即清除跑道警戒倒數並關閉跑道保護（不影響 Zone/Mask/手動標記等設定）"
            className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 rounded hover:bg-red-500/20 transition-colors text-sm disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            RESET
          </button>
          <button
            onClick={loadConfig}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-300 rounded hover:bg-gray-700 transition-colors text-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新載入
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/20 border border-yellow-500/30 text-yellow-300 rounded hover:bg-yellow-500/30 transition-colors text-sm disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? '儲存中...' : '儲存'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-xs text-red-400 bg-red-950/30 border border-red-800 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h2 className="text-sm font-medium text-gray-400 mb-3 uppercase tracking-wider flex items-center gap-2">
          <Play className="w-3.5 h-3.5" />
          示範影片來源 · AI / 動態 / 手動偵測 · 區域框選
        </h2>
        <div className="flex gap-4">
          {/* Player — bigger (960px) since precise drag-to-draw is a regular
              part of this page's job now too; a small preview makes fine
              region placement hard. */}
          <div className="flex-shrink-0" style={{ width: 960 }}>
            <div className="relative">
              <video
                ref={setVideoRef}
                src="/api/detector/video"
                autoPlay
                loop
                muted
                playsInline
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration || 0);
                  drawRegionOverlay();
                }}
                onTimeUpdate={handleVideoTimeUpdate}
                onSeeking={handleVideoSeeking}
                onSeeked={handleVideoSeeked}
                className="rounded-t border border-gray-800 bg-black block w-full"
              />
              <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              <canvas
                ref={regionCanvasRef}
                onMouseDown={onRegionMouseDown}
                onMouseMove={onRegionMouseMove}
                onMouseUp={onRegionMouseUp}
                className="absolute inset-0 w-full h-full"
                style={{
                  pointerEvents: drawingRegion || drawingLine ? 'auto' : 'none',
                  cursor: drawingRegion || drawingLine ? 'crosshair' : 'default',
                }}
              />
            </div>
            {drawingRegion && (
              <div className="text-[10px] text-cyan-400 mt-1">
                {editingZoneId ? `拖曳重新框選 ${editingZoneId}，放開滑鼠確認` : '拖曳畫出動態偵測範圍，放開滑鼠確認'}
              </div>
            )}
            {drawingLine && (
              <div className="text-[10px] text-red-400 mt-1">
                拖曳畫出跑道入侵線，放開滑鼠確認
              </div>
            )}
            <div className="px-2 py-1.5 bg-[#0a0a0a] border border-t-0 border-gray-800 rounded-b">
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={currentTime}
                onChange={(e) => seek(parseFloat(e.target.value))}
                className="w-full h-1 accent-cyan-400 cursor-pointer"
              />
              <div className="flex items-center justify-between mt-1">
                <span className="font-mono text-[9px] text-gray-600">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
                <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500">
                  ×1
                </span>
              </div>
              <div className="mt-1 font-mono text-[9px] text-gray-600">
                同步：{syncDebug.connected ? <span className="text-green-500">已連線</span> : <span className="text-red-500">未連線</span>}
                {' · '}
                {syncDebug.lastSyncAt
                  ? `上次收到 ${Math.max(0, Math.round((nowTick - syncDebug.lastSyncAt) / 1000))}s 前`
                  : '尚未收到任何同步'}
                {' · 誤差 '}
                <span style={{ color: Math.abs(syncDebug.driftS) > 0.15 ? '#ff4444' : '#00ff88' }}>
                  {syncDebug.driftS >= 0 ? '+' : ''}{syncDebug.driftS.toFixed(2)}s
                </span>
              </div>
            </div>
          </div>

          {/* Status + controls + zone list */}
          <div className="flex-1 min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border cursor-pointer"
                style={
                  aiEnabled
                    ? modelStatus === 'ready'
                      ? { borderColor: 'rgba(0,255,136,0.3)', background: 'rgba(0,255,136,0.1)', color: '#00ff88' }
                      : modelStatus === 'error'
                      ? { borderColor: 'rgba(255,68,68,0.3)', background: 'rgba(255,68,68,0.1)', color: '#ff4444' }
                      : { borderColor: 'rgba(255,215,0,0.3)', background: 'rgba(255,215,0,0.1)', color: '#ffd700' }
                    : { borderColor: '#374151', background: 'transparent', color: '#6b7280' }
                }
              >
                <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} className="accent-current" />
                {aiEnabled && modelStatus === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                AI 偵測{aiEnabled ? `（${modelStatus === 'ready' ? '偵測中' : modelStatus === 'error' ? '載入失敗' : '載入中...'}）` : '（已關閉）'}
              </label>

              <label
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border cursor-pointer"
                style={
                  motionEnabled
                    ? { borderColor: 'rgba(0,200,255,0.3)', background: 'rgba(0,200,255,0.1)', color: '#00c8ff' }
                    : { borderColor: '#374151', background: 'transparent', color: '#6b7280' }
                }
              >
                <input type="checkbox" checked={motionEnabled} onChange={(e) => setMotionEnabled(e.target.checked)} className="accent-current" />
                動態偵測{motionEnabled ? ` · ${(motionLevel * 100).toFixed(1)}%` : '（已關閉）'}
              </label>

              <label className="flex items-center gap-1.5 text-xs text-gray-500">
                觸發聯絡道
                <select
                  value={config.video_trigger_taxiway_id}
                  onChange={(e) => setConfig({ ...config, video_trigger_taxiway_id: e.target.value })}
                  className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-300"
                >
                  {ALL_TAXIWAY_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
            </div>

            {motionEnabled && (
              <div>
                <div className="h-1.5 rounded bg-gray-800 overflow-hidden" title={`動態偵測門檻 ${(config.motion_threshold * 100).toFixed(0)}%`}>
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${Math.min(100, (motionLevel / (config.motion_threshold * 3)) * 100)}%`,
                      background: motionLevel >= config.motion_threshold ? '#00c8ff' : '#374151',
                    }}
                  />
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-gray-500 shrink-0">動態偵測門檻</span>
                  <input
                    type="range"
                    min={0.01}
                    max={0.3}
                    step={0.01}
                    value={config.motion_threshold}
                    onChange={(e) => persistConfig({ ...config, motion_threshold: parseFloat(e.target.value) })}
                    className="w-full h-1 accent-cyan-400 cursor-pointer"
                  />
                  <span className="font-mono text-[10px] text-gray-500 shrink-0 w-9 text-right">
                    {(config.motion_threshold * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="text-[10px] text-gray-600 mt-1">
                  畫面變化超過這個比例才算「有動態」——太低容易被壓縮雜訊誤觸發，太高會漏掉真的移動。下方每個區域旁的百分比是即時分數/門檻（綠色 = 現在就會觸發）。
                </div>
              </div>
            )}

            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-2 text-gray-400">
                <span className="text-gray-600 w-24 shrink-0">最近一次偵測</span>
                {lastDetection
                  ? <span>{lastDetection.source.replace('DETECTOR-VIDEO-', '')} · 信心值 {(lastDetection.score * 100).toFixed(0)}% · {lastDetection.at}</span>
                  : <span className="text-gray-600">尚未偵測到飛機</span>}
              </div>
              <div className="flex items-center gap-2 text-gray-400">
                <span className="text-gray-600 w-24 shrink-0">AI 判讀現況</span>
                {analysisStatus === 'REANALYZING' ? (
                  <span className="flex items-center gap-1.5 text-yellow-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                    重新分析場上狀態中…
                  </span>
                ) : currentStatus ? (
                  <span className="text-cyan-300">
                    分析完成 · {currentStatus.label} · {currentStatus.taxiwayId} ·
                    {' '}{Math.max(0, Math.round((nowTick - currentStatus.at) / 1000))}s 前
                  </span>
                ) : (
                  <span className="text-gray-600">分析完成 · 尚未偵測到動態</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-gray-400">
                <span className="text-gray-600 w-24 shrink-0">已觸發次數</span>
                <span>{triggerCount}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-600 w-24 shrink-0">跑道警戒</span>
                {alertSecondsLeft > 0 ? (
                  <span className="flex items-center gap-1.5 text-yellow-400 font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                    警戒中 · 剩餘 {alertSecondsLeft}s
                  </span>
                ) : (
                  <span className="text-gray-600">閒置</span>
                )}
              </div>
              {aiEnabled && (
                <div className="flex items-start gap-2 text-gray-400">
                  <span className="text-gray-600 w-24 shrink-0 pt-0.5">AI 目前看到</span>
                  {rawPredictions.length === 0 ? (
                    <span className="text-gray-600">（無）</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono">
                      {rawPredictions
                        .slice()
                        .sort((a, b) => b.score - a.score)
                        .slice(0, 6)
                        .map((p, i) => (
                          <span key={i} className={p.class === 'airplane' ? 'text-cyan-400' : 'text-gray-500'}>
                            {p.class} {(p.score * 100).toFixed(0)}%
                          </span>
                        ))}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* 跑道入侵線 — separate, safety-critical trigger: crossing it
                reports a detection the same way any zone does (the backend
                already checks real authorization state and only latches
                INCURSION_LATCHED if it wasn't authorized), but also attaches
                a real camera snapshot to the resulting event instead of a
                generated placeholder image. */}
            <div className="rounded border border-red-900/50 bg-red-950/10 p-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-red-400">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  跑道入侵線
                </span>
                <button
                  onClick={() => {
                    setDrawingRegion(false); setEditingZoneId(null); // mutually exclusive with zone drawing
                    setDrawingLine((v) => !v);
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-colors"
                  style={
                    drawingLine
                      ? { borderColor: '#ff4444', background: 'rgba(255,68,68,0.15)', color: '#ff4444' }
                      : { borderColor: '#7f1d1d', background: 'transparent', color: '#f87171' }
                  }
                >
                  <Plus className="w-3 h-3" />
                  {drawingLine ? '框選中...' : config.incursion_line ? '重新框選' : '畫入侵線'}
                </button>
              </div>
              {config.incursion_line ? (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-gray-500">凡未經授權跨越此線，即時拍照存入事件中心 → 對應聯絡道</span>
                  <ZoneScoreBadge
                    score={zoneScores[config.incursion_line.id]}
                    threshold={config.incursion_line.threshold ?? config.motion_threshold}
                  />
                  <ZoneThresholdControl
                    value={config.incursion_line.threshold}
                    defaultValue={config.motion_threshold}
                    onChange={setIncursionLineThreshold}
                  />
                  <select
                    value={config.incursion_line.taxiway_id}
                    onChange={(e) => setIncursionLineTaxiway(e.target.value)}
                    className="ml-auto bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-300"
                  >
                    {ALL_TAXIWAY_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                  <button onClick={removeIncursionLine} className="text-gray-600 hover:text-red-400">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="text-[11px] text-gray-600">尚未設定入侵線，不會產生真實跑道入侵偵測。</div>
              )}
            </div>

            <button
              onClick={() => {
                setDrawingLine(false); // mutually exclusive with line drawing
                setEditingZoneId(null); // this button always starts a brand-new zone
                setDrawingRegion((v) => !v);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border transition-colors"
              style={
                drawingRegion && !editingZoneId
                  ? { borderColor: '#00c8ff', background: 'rgba(0,200,255,0.15)', color: '#00c8ff' }
                  : { borderColor: '#374151', background: 'transparent', color: '#9ca3af' }
              }
            >
              <Plus className="w-3.5 h-3.5" />
              {drawingRegion && !editingZoneId ? '框選中...' : '新增偵測區域'}
            </button>

            {config.motion_zones.length === 0 ? (
              <div className="text-[11px] text-gray-600">尚未設定偵測區域，動態偵測不會掃描任何畫面。</div>
            ) : (
              <div className="space-y-1.5">
                {config.motion_zones.map((zone, i) => (
                  <div
                    key={zone.id}
                    className="flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded border text-xs"
                    style={{ borderColor: ZONE_COLORS[i % ZONE_COLORS.length] + '55', background: ZONE_COLORS[i % ZONE_COLORS.length] + '14' }}
                  >
                    <span style={{ color: ZONE_COLORS[i % ZONE_COLORS.length] }} className="font-mono font-medium">{zone.id}</span>
                    {ZONE_PHASE_LABELS[zone.id] ? (
                      <span className="text-gray-500">{ZONE_PHASE_LABELS[zone.id]}</span>
                    ) : (
                      <span className="text-gray-600 italic">（無特殊語意）</span>
                    )}
                    <ZoneScoreBadge score={zoneScores[zone.id]} threshold={zone.threshold ?? config.motion_threshold} />
                    <ZoneThresholdControl
                      value={zone.threshold}
                      defaultValue={config.motion_threshold}
                      onChange={(v) => setMotionZoneThreshold(zone.id, v)}
                    />
                    <select
                      value={zone.taxiway_id}
                      onChange={(e) => setMotionZoneTaxiway(zone.id, e.target.value)}
                      className="ml-auto bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-300"
                    >
                      {ALL_TAXIWAY_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
                    </select>
                    <button
                      onClick={() => {
                        setDrawingLine(false); // mutually exclusive with line drawing
                        setEditingZoneId(zone.id);
                        setDrawingRegion(true);
                      }}
                      title={`重新框選 ${zone.id} 的偵測範圍（不會變成新的區域，仍是 ${zone.id}）`}
                      className="text-gray-600 hover:text-cyan-400"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => removeMotionZone(zone.id)} className="text-gray-600 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Manual marks — fallback when neither automatic method catches it */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-gray-500 uppercase tracking-wider">手動標記（{config.video_trigger_seconds.length}）</span>
                <button
                  onClick={markPlaneHere}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
                >
                  <Plane className="w-3 h-3" />
                  標記目前畫面有飛機
                </button>
              </div>
              {config.video_trigger_seconds.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {config.video_trigger_seconds.map((t) => (
                    <span key={t} className="flex items-center gap-1 font-mono text-[10px] text-gray-400 bg-gray-800/50 rounded px-1.5 py-0.5">
                      <button onClick={() => seek(t)} className="text-cyan-400 hover:underline">{t.toFixed(1)}s</button>
                      <button onClick={() => removeTrigger(t)} className="text-gray-600 hover:text-red-400">
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 事件判定 Debug */}
            <div className="rounded border border-gray-800 bg-black/30 p-2.5">
              <div className="text-xs font-medium text-gray-400 mb-1.5 flex items-center gap-1.5">
                <Crosshair className="w-3.5 h-3.5" />
                事件判定 Debug
              </div>
              <div className="font-mono text-[10px] text-gray-500 space-y-1">
                {seekDebug && (
                  <div className="text-gray-600">
                    跳轉除錯 seekRequestId={seekDebug.seekRequestId} · targetTime={formatTime(seekDebug.targetTime)} ({seekDebug.targetTime.toFixed(3)}s)
                  </div>
                )}
                {Object.entries(runwayDebug).map(([taxiwayId, d]) => (
                  <div key={taxiwayId} className="text-gray-500 space-y-0.5">
                    <div>
                      {taxiwayId} · analysisTimestamp={new Date(d.analysisTimestamp).toLocaleTimeString('zh-TW', { hour12: false })}
                      {' '}· motion={(d.motionScore * 100).toFixed(1)}%/{(d.motionThreshold * 100).toFixed(0)}%
                    </div>
                    <div>
                      Z1.motion={String(d.z1Motion)} Z2.motion={String(d.z2Motion)} Z3.triggered={String(d.z3Triggered)}
                      {' '}· transitioned={String(d.transitioned)} · currentAnimation={d.currentAnimation}
                    </div>
                    {d.events.map((e, i) => (
                      <div key={i} className="pl-2 border-l border-gray-800">
                        <div>
                          #{i + 1} state={e.state} · entryAnimationCompleted={String(e.entryAnimationCompleted)}
                        </div>
                        <div>{e.eventReason}</div>
                      </div>
                    ))}
                    {d.events.length === 0 && <div className="pl-2 text-gray-600">NO_ACTIVE_EVENT</div>}
                  </div>
                ))}
                {Object.keys(runwayDebug).length === 0 && <div className="text-gray-600">尚無任何 taxiway 的判定資料</div>}
              </div>
            </div>

            {/* 告警 Gate + 去重 Debug */}
            <div className="rounded border border-gray-800 bg-black/30 p-2.5">
              <div className="text-xs font-medium text-gray-400 mb-1.5 flex items-center gap-1.5">
                <Crosshair className="w-3.5 h-3.5" />
                告警 Gate + 去重 Debug
              </div>
              <div className="font-mono text-[10px] text-gray-500 space-y-1.5">
                {Object.entries(runwayDebug).map(([taxiwayId, d]) => (
                  <div key={taxiwayId} className="text-gray-500 space-y-0.5 pb-1 border-b border-gray-900 last:border-0">
                    <div>
                      {taxiwayId} · systemStatus={d.systemStatus} · monitoringEnabled={String(d.monitoringEnabled)}
                      {' '}· runwayAlertState={d.runwayAlertState}
                      {' '}· canIssueIncursionAlert=
                      <span style={{ color: d.canIssueIncursionAlert ? '#00ff88' : '#ff4444' }}>{String(d.canIssueIncursionAlert)}</span>
                    </div>
                    <div>
                      aircraftEventId={d.aircraftEventId ?? '—'} · alertEventId={d.alertEventId ?? '—'}
                    </div>
                    <div>
                      alertAlreadyShown={String(d.alertAlreadyShown)} · alertSoundAlreadyPlayed={String(d.alertSoundAlreadyPlayed)}
                      {' '}· alertDismissed={String(d.alertDismissed)} · serverIncursionLatched={String(d.serverIncursionLatched)}
                    </div>
                    <div>
                      noAlertReason=
                      <span style={{ color: d.noAlertReason === 'ALERT_ISSUED' ? '#00ff88' : '#6b7280' }}>{d.noAlertReason}</span>
                    </div>
                  </div>
                ))}
                {Object.keys(runwayDebug).length === 0 && <div className="text-gray-600">尚無任何 taxiway 的判定資料</div>}
              </div>
            </div>

            {/* Local-first + Server Reconciliation Debug */}
            <div className="rounded border border-gray-800 bg-black/30 p-2.5">
              <div className="text-xs font-medium text-gray-400 mb-1.5 flex items-center gap-1.5">
                <Crosshair className="w-3.5 h-3.5" />
                Local-first Debug（aiDetectionStateStore）
              </div>
              <div className="font-mono text-[10px] text-gray-500 space-y-1.5">
                {Object.entries(runwayDebug).map(([taxiwayId, d]) => {
                  const s = d.aiSnapshot;
                  const timing = getTiming(taxiwayId as TaxiwayId);
                  if (!s) return null;
                  return (
                    <div key={taxiwayId} className="text-gray-500 space-y-0.5 pb-1 border-b border-gray-900 last:border-0">
                      <div>
                        {taxiwayId} · eventId={s.eventId} · sequence={s.sequence} · generationId={s.generationId}
                      </div>
                      <div>
                        source={s.source} · status={s.status} · eventType={s.decision.eventType} · incursionLatched={String(s.decision.incursionLatched)}
                      </div>
                      {timing && (
                        <div>
                          analyzedAt={new Date(timing.analyzedAt).toLocaleTimeString('zh-TW', { hour12: false })}
                          {' '}· publishedAt=+{timing.publishedAt - timing.analyzedAt}ms
                          {' '}· localAppliedAt={timing.localAppliedAt !== null ? `+${timing.localAppliedAt - timing.analyzedAt}ms` : '—'}
                          {' '}· serverAppliedAt={timing.serverAppliedAt !== null ? `+${timing.serverAppliedAt - timing.analyzedAt}ms` : '—'}
                        </div>
                      )}
                      {timing && (
                        <div>
                          localUiLatency={timing.localUiLatency !== null ? `${timing.localUiLatency}ms` : '—'}
                          {' '}· serverRoundTripLatency={timing.serverRoundTripLatency !== null ? `${timing.serverRoundTripLatency}ms` : '—'}
                        </div>
                      )}
                    </div>
                  );
                })}
                {Object.keys(runwayDebug).length === 0 && <div className="text-gray-600">尚無任何 taxiway 的判定資料</div>}
              </div>
            </div>

            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800">
              Z1/Z2/Z3 是固定的操作員約定，供 AirportSimPanel（機場地面模擬）判讀一台飛機「進入聯絡道 → 跑道頭等待 → 起飛」三個階段用；Z4 以後的區域一樣能框選、對應聯絡道，只是沒有特殊語意。
              Z1 觸發時會自動把跑道撥入警戒（保護）狀態並啟動跑道警戒倒數（{(RUNWAY_ALERT_DURATION_MS / 1000 / playbackRate).toFixed(1)} 秒，依目前 ×{playbackRate} 播放速度等比例縮短）；Z2/Z3 只能延長已經在跑的倒數，不能無中生有啟動警戒或建立倒數。三者都不會自行發出入侵警告；只有跨越跑道入侵線、且通過上方「canIssueIncursionAlert」Gate（系統 RUNNING、監控啟用、跑道已警戒）才會真的發出警告與寫入正式紀錄。
              系統（STM）不會自動開機——需操作員自行啟動；系統已啟動後，跑道保護可由 Z1 自動開啟，也可由操作員手動開啟。
              最後更新：{config.updated_at} · 修改後記得按「儲存」。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
