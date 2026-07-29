// 偵測器後台管理
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
//      的專用模型，遠距離/小畫面的飛機不一定測得到——「目前偵測到」debug 清單
//      會列出模型每個 tick 實際看到的所有類別跟分數，方便判斷是完全沒測到還是
//      誤判成別的東西。
//   2. 動態偵測（Motion）：簡單的逐幀差異比對，裁切到操作員畫出的一或多個
//      「偵測區域」（config.motion_zones，Z1/Z2/Z3...；框選/編輯在獨立的
//      ZoneConfig.tsx「偵測區域設定」頁，這頁只讀不編輯，見下方唯讀疊圖）；
//      每個區域各自獨立比對、各自對應自己的 taxiway_id，例如 Z1 框住某個聯絡
//      道口、Z2 框住另一個，各自觸發各自的滑行道，不像 AI/手動標記共用同一個
//      「觸發聯絡道」下拉選單，再縮小到 MOTION_SAMPLE_W x MOTION_SAMPLE_H 比對
//      像素差異量，概念上對應 RIWS-POC 桌面版用
//      cv2.createBackgroundSubtractorMOG2() 補捉 YOLO 漏掉的角度。不特別分辨
//      「是不是飛機」，區域內任何明顯移動都算，所以框選範圍很重要——沒有設定
//      任何區域就完全不會掃描（不會退回掃整個畫面），框住跑道/聯絡道口才準確。
//      有獨立開關可以整個關掉。掃描迴圈留在這頁（而不是搬去 ZoneConfig.tsx）
//      是因為這頁的 <video> 元素必須不管在不在畫面上都持續在背景播放/解碼
//      （見 Layout.tsx 的 always-mounted 說明）——ZoneConfig.tsx 是普通路由頁
//      面，切走就會卸載，沒辦法拿來跑背景偵測。
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
// 立即結束目前的警戒倒數，並短暫（MANUAL_CLEAR_SUPPRESS_MS，見
// DetectorAlertService.ts）忽略新的 arm() 請求，因為 AI/Motion 偵測迴圈不管
// 在哪一頁都持續在背景跑，若沒有這個緩衝，RESET 當下畫面上如果還看得到飛機，
// 下一個 tick 就會立刻重新警戒，操作員永遠看不到「乾淨」的重置結果。
//
// 跑道警戒倒數（armRunwayAlert）也是伺服器端狀態（server/src/services/
// DetectorAlertService.ts），不是這頁自己算自己的 setTimeout——這樣「主戰情表」
// 才能顯示同一個倒數，而不是只有觸發偵測的那個分頁看得到。

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Crosshair, Save, RefreshCw, Play, Loader2, Plane, Trash2, RotateCcw, Frame, AlertTriangle } from 'lucide-react';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { detectorApi, demoApi } from '../services/api';
import { DetectorConfig, DetectorMotionZone, ALL_TAXIWAY_IDS } from '../types';
import { useVideoSync } from '../hooks/useVideoSync';
import { useDetectorAlert } from '../hooks/useDetectorAlert';
import { getSocket } from '../services/socketService';
import { setDetectorVideoElement } from '../services/detectorVideoRegistry';

const DETECT_INTERVAL_MS = 500;
// Lowered from 0.5 — COCO-SSD is a general-purpose model, not trained on
// airport surveillance footage, and a distant/small airplane in a wide CCTV
// shot often scores lower than a close-up photo would. If AI still misses
// real planes, check the "目前偵測到" debug list: it shows ALL classes
// COCO-SSD sees each tick (not just airplane) so you can tell whether it's
// seeing nothing, or misclassifying the plane as something else — and there
// are two other detection sources (motion, manual mark) as fallbacks.
const CONFIDENCE_THRESHOLD = 0.35;
const TRIGGER_COOLDOWN_MS = 20000;
// A detection (from any of the 3 sources) arms runway protection for this
// long; another detection before it expires extends the window rather than
// stacking a second timer.
const RUNWAY_ALERT_DURATION_MS = 30000;
// Motion detection: downscaled frame-diff sample size (perf). The
// fraction-of-pixels-changed threshold that counts as "something moved" is
// adjustable at runtime (config.motion_threshold, persisted — see
// ZoneConfig.tsx, which also shows/edits it) — it was a fixed 0.02
// originally and turned out to fire too easily (compression noise/small
// background movement), so it's a live slider now instead of another guess
// at a magic number.
const MOTION_SAMPLE_W = 160;
const MOTION_SAMPLE_H = 90;
// Manual marks: timeupdate fires a few times a second, not every frame — a
// small window around each marked second so a mark isn't missed.
const TRIGGER_TOLERANCE_S = 0.35;

const SPEED_OPTIONS = [1, 2, 3, 5];

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Cycled by index so each zone's overlay rect/label is visually distinct —
// must match ZoneConfig.tsx's own ZONE_COLORS so a zone looks the same color
// on both pages.
const ZONE_COLORS = ['#00c8ff', '#ff9f1c', '#c792ea', '#00ff88', '#ff6b6b', '#ffd93d'];

// Z1/Z2/Z3 carry fixed operational meaning (operator-assigned convention,
// not derived from anything) — the same飛機一次通過的三個階段：Z1 進入聯絡道
// -> Z2 在跑道頭等待 -> Z3 起飛. determineRunwayEvent below keys off these
// exact zone ids (matched by object identity per taxiway, see the tick loop)
// to judge ONE event per taxiway per tick, which AirportSimPanel.
// spawnAtTaxiway then just plays back — see that function's comment. Zones
// beyond Z1-3 have no defined phase. Duplicated in ZoneConfig.tsx (that page
// owns editing; this page only needs it for the read-only overlay/summary
// below) rather than sharing a module — small enough that a shared import
// isn't worth the indirection.
const ZONE_PHASE_LABELS: Record<string, string> = {
  Z1: '進入聯絡道',
  Z2: '跑道頭等待',
  Z3: '起飛',
};

// ── 跑道事件判定（先判定事件，再播放對應動畫）───────────────────────────────
// Single source of truth for "what's happening on this taxiway right now",
// shared by the "AI 判讀現況" text below and the ground-sim spawn emitted
// from the motion tick loop. Deliberately NOT derived inside a per-zone
// callback (onZ1Detected/onZ2Detected/... style) — every zone's hit state
// for the SAME tick must be collected first (see the tick loop's zoneSnapshot
// construction), then this pure function picks exactly one event from that
// complete snapshot. That's what stops "Z2 fires -> play entering animation
// -> Z3 fires a moment later -> switch to takeoff" — the animation-worthy
// event is decided once, from a full snapshot, never from Z2 alone.
//
// Z1 alone is intentionally NOT its own event (no ENTERING/進入聯絡道 case) —
// only TAKEOFF, RUNWAY_HOLDING and RUNWAY_HOLDING_PENDING are defined
// events; anything else, including Z1 by itself, is NONE.
//
// RUNWAY_HOLDING_PENDING exists because "Z1+Z2 fired together" (the LATCH,
// see runwayHoldingLatchedRef below) and "Z2 currently shows real, sustained
// motion" (z2Motion) are deliberately two different bars: the latch fires
// once, permanently, the instant Z1+Z2 first co-occur — that's what keeps
// the waiting icon showing even through normal zone flicker afterward — but
// the WAITING ANIMATION specifically must not start playing off that same
// single co-occurring tick; it waits for Z2's own confirmed motion, same as
// TAKEOFF waits for z3Triggered rather than a raw single-tick Z3 hit.
// PENDING is "icon-worthy, not yet animation-worthy"; RUNWAY_HOLDING is both.
type RunwayEvent = 'TAKEOFF' | 'RUNWAY_HOLDING' | 'RUNWAY_HOLDING_PENDING' | 'NONE';

const RUNWAY_EVENT_LABELS: Record<Exclude<RunwayEvent, 'NONE'>, string> = {
  TAKEOFF: '起飛',
  RUNWAY_HOLDING: '跑道頭等待',
  // Same label as RUNWAY_HOLDING on purpose — to an operator reading this
  // text, the plane genuinely IS heading to/waiting at the threshold in
  // both cases; PENDING vs confirmed only matters for whether the ground-sim
  // animation is allowed to play, which the debug panel below shows
  // separately (confirmedEvent / z2Motion).
  RUNWAY_HOLDING_PENDING: '跑道頭等待',
};

// z3Triggered is NOT the same as z3 (this tick's raw threshold hit, exposed
// separately below only as debug/informational — e.g. motionLevel — never as
// a takeoff gate on its own). z3Triggered is whether Z3 has hit for
// EVENT_CONFIRM_TICKS consecutive ticks in a row (see the tick loop's
// z3StreakRef) — a single noisy frame crossing threshold must never be
// enough to call TAKEOFF on its own; only sustained, confirmed motion earns
// "triggered". validTakeoff below checks z3Triggered ALONE — deliberately
// not `z3 && z3Triggered`, since z3StreakRef already resets to 0 (making
// z3Triggered false) the instant a tick misses, so z3Triggered can never be
// true without z3 also being true that same tick; anything else would be a
// redundant, misleading condition.
//
// runwayHoldingLatched/z2Motion are both caller-maintained (tick loop), not
// derived here — this stays a pure function of whatever snapshot it's given,
// same as before; the STATEFULNESS (the latch persisting across ticks, the
// z2 streak) lives entirely in the tick loop's refs, exactly like
// z3StreakRef already does for z3Triggered.
interface RunwayZoneSnapshot {
  z1: boolean;
  z2: boolean;
  z3: boolean;
  z3Triggered: boolean;
  runwayHoldingLatched: boolean;
  z2Motion: boolean;
}

function determineRunwayEvent(z: RunwayZoneSnapshot): RunwayEvent {
  const validTakeoff = z.z3Triggered === true;
  const validRunwayHolding = z.runwayHoldingLatched === true && z.z2Motion === true;
  // Priority is fixed: TAKEOFF > RUNWAY_HOLDING > RUNWAY_HOLDING_PENDING >
  // NONE. Z3.triggered wins even if the runway-holding latch and Z2 motion
  // are also both true this tick — takeoff is never downgraded to a
  // lower-priority event just because the plane was also seen waiting.
  if (validTakeoff) return 'TAKEOFF';
  if (validRunwayHolding) return 'RUNWAY_HOLDING';
  if (z.runwayHoldingLatched) return 'RUNWAY_HOLDING_PENDING';
  return 'NONE';
}

// How many consecutive detection ticks (DETECT_INTERVAL_MS apart) a signal
// must hold before it's trusted — applied twice below: once to Z3 alone
// (turns a raw hit into "confirmed motion"), once to the final determined
// event itself (so a flip-flopping zone combo can't restart/switch the
// ground-sim animation every single tick either). 3 ticks @ 500ms = 1.5s.
const EVENT_CONFIRM_TICKS = 3;
// Z2.motion's bar over Z2.triggered's own threshold — see the tick loop's
// z2Motion comment for why this needs to be a stronger-score check rather
// than a streak like z3Triggered. 1.5x is a starting point, not a measured
// calibration; tune alongside the zone's own threshold slider if real
// footage shows this taking too long (or not long enough) to confirm.
const Z2_MOTION_THRESHOLD_MULTIPLIER = 1.5;

export function DetectorConfigPage() {
  const [config, setConfig] = useState<DetectorConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // marks and motion-region drawing — those cost real effort (precise
  // dragging, timing) to redo, so they must never depend on the operator
  // remembering to click "儲存" afterward; a page refresh before that click
  // (e.g. for unrelated debugging) would otherwise silently lose them, which
  // is exactly what happened before this existed. The taxiway dropdown and
  // "儲存" button stay manual-save — trivial to redo, not worth the extra
  // network chatter on every keystroke/selection.
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

  // ── Player (synced with LiveMonitor's VideoFeed via useVideoSync) ───────
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
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
  // Default 3x — the source clip is mostly idle taxiing, 3x keeps demo
  // pacing tighter without needing a shorter/edited source file.
  const [playbackRate, setPlaybackRate] = useState(3);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // Read by armRunwayAlert to scale RUNWAY_ALERT_DURATION_MS with playback
  // speed (kept in a ref, not read from state directly, so a speed change
  // doesn't need to be a dependency of the detection effects/armRunwayAlert).
  const playbackRateRef = useRef(playbackRate);
  useEffect(() => { playbackRateRef.current = playbackRate; }, [playbackRate]);

  const applyRate = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
      publish(rate, videoRef.current.currentTime);
    }
  };

  const seek = (t: number) => {
    setCurrentTime(t);
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      publish(playbackRate, t);
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
  // say is happening on the field (Z1 進入聯絡道 / Z2 跑道頭等待 / Z2+Z3 起飛
  // — same phase logic AirportSimPanel.spawnAtTaxiway uses for the ground-sim
  // projection, just surfaced as text here instead of an animated icon).
  // Kept until the next zone hit rather than clearing every tick nothing
  // fires — motion sampling is intermittent even for continuous real
  // motion, so clearing on every quiet tick would just flicker.
  const [currentStatus, setCurrentStatus] = useState<{ label: string; taxiwayId: string; at: number } | null>(null);
  const [triggerCount, setTriggerCount] = useState(0);
  const [rawPredictions, setRawPredictions] = useState<cocoSsd.DetectedObject[]>([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [motionLevel, setMotionLevel] = useState(0);
  // config.motion_threshold, not local state — persisted (see
  // DetectorConfigService's DEFAULT_CONFIG for the 0.06 default) so
  // ZoneConfig.tsx can also show/edit the same value while calibrating
  // zones. Read inside the tick's setInterval closure via a ref so it
  // doesn't need to be a dependency of the detection effect.
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
  const [nowTick, setNowTick] = useState(Date.now());

  // 200ms, not 1000ms: alertUntil is the same shared value on every page
  // (see useDetectorAlert), but each page's countdown display is sampled by
  // its own independent local timer. At a 1s tick, two pages checking the
  // SAME underlying deadline at different phases can legitimately round to
  // different integers (e.g. 6s here, 7s there) even though nothing is
  // actually out of sync — just display jitter. With windows now as short
  // as 6-9s that ±1s was a large fraction of the total, easy to mistake for
  // a real desync. 200ms shrinks the worst case to a fifth of a second.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  const alertSecondsLeft = alertUntil ? Math.max(0, Math.ceil((alertUntil - nowTick) / 1000)) : 0;

  const armRunwayAlert = useCallback(async () => {
    // RUNWAY_ALERT_DURATION_MS is calibrated for 1x playback; scale it down
    // by the current speed so the alert window stays paced with the sped-up
    // video instead of feeling disproportionately long at e.g. 5x.
    const scaledDurationMs = RUNWAY_ALERT_DURATION_MS / playbackRateRef.current;
    await detectorApi.armAlert(scaledDurationMs).catch(() => {
      // Best-effort — demoApi.detect() right after this just no-ops if the
      // system still isn't ready.
    });
  }, []);

  // Common landing spot for all 3 detection sources. taxiwayId defaults to
  // the "觸發聯絡道" dropdown (AI/manual mark both trigger for the whole
  // frame) — motion detection passes the specific zone's own taxiway_id
  // instead, since each motion zone maps to a different taxiway.
  const reportPlaneDetected = useCallback(async (source: string, confidence: number, taxiwayId?: string, zoneId?: string, snapshotBase64?: string) => {
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

    await armRunwayAlert();
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
    // which zones fired TOGETHER in the same tick (Z2+Z3 == takeoff, Z1+Z2
    // == two separate planes — see AirportSimPanel.spawnAtTaxiway), which
    // this per-zone, per-call function can't see on its own.
  }, [armRunwayAlert]);

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
  }, [modelStatus, aiEnabled, isVisible, drawOverlay, reportPlaneDetected, armRunwayAlert]);

  // ── 2. Motion detection (frame-diff, independent of the AI model) ───────
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // One diff baseline per zone (keyed by zone id) — each zone crops a
  // different part of the frame, so they can't share a single baseline.
  const prevFramesRef = useRef<Map<string, Uint8ClampedArray>>(new Map());
  // Operator-drawn zones (config.motion_zones) — see the drawing UI below.
  // Kept in a ref so the tick loop doesn't need `config` as a dep (avoids
  // restarting the detection interval on every unrelated config edit).
  const motionZonesRef = useRef<DetectorMotionZone[]>([]);
  // The single 跑道入侵線 (config.incursion_line, drawn on ZoneConfig.tsx) —
  // kept separate from motionZonesRef since it's scored the same way but
  // handled differently on a hit (real snapshot, no ground-sim projection).
  const incursionLineRef = useRef<DetectorMotionZone | null>(null);
  // Per-taxiway event-determination state (see determineRunwayEvent) — keyed
  // by taxiway_id, all three reset together whenever zones are redrawn since
  // a streak/pending count from the old zone layout isn't meaningful once
  // the rects (and what they mean) have changed.
  //   z3StreakRef: consecutive ticks Z3 has hit THIS taxiway in a row —
  //     resets to 0 the instant Z3 misses a tick. Feeds z3Triggered.
  //   pendingEventRef: the raw event determineRunwayEvent computed on the
  //     LAST tick for this taxiway, plus how many consecutive ticks it's
  //     held — resets its count whenever the raw event changes.
  //   confirmedEventRef: the event actually acted on (emitted/displayed) —
  //     only updated once pendingEventRef's count reaches EVENT_CONFIRM_TICKS
  //     AND it differs from what's already confirmed (see 六、避免重複播放).
  //   runwayHoldingLatchedRef: true forever once Z1+Z2 have EVER hit
  //     together on the same tick for this taxiway — deliberately NOT reset
  //     by normal zone flicker (a momentary Z1/Z2 miss, a brief detection
  //     drop-out), and NOT cleared just because this taxiway's TAKEOFF later
  //     confirms either (見驗收測試七 — the waiting icon must survive the
  //     takeoff animation starting, not be cleared as a side effect of it).
  //     This is what keeps the waiting icon showing continuously even though
  //     the raw Z1/Z2 booleans themselves come and go — see
  //     determineRunwayEvent's RUNWAY_HOLDING_PENDING case. Cleared ONLY by
  //     resetTemporalDetectionState (video seek — including a plain <video
  //     loop> wrap, which fires the same native events — or an explicit
  //     demo reset).
  const z3StreakRef = useRef<Map<string, number>>(new Map());
  const runwayHoldingLatchedRef = useRef<Map<string, boolean>>(new Map());
  const pendingEventRef = useRef<Map<string, { event: RunwayEvent; count: number }>>(new Map());
  const confirmedEventRef = useRef<Map<string, RunwayEvent>>(new Map());

  useEffect(() => {
    motionZonesRef.current = config?.motion_zones ?? [];
    incursionLineRef.current = config?.incursion_line ?? null;
    prevFramesRef.current = new Map(); // zone set/rects changed — old baselines no longer comparable
    z3StreakRef.current = new Map();
    runwayHoldingLatchedRef.current = new Map();
    pendingEventRef.current = new Map();
    confirmedEventRef.current = new Map();
  }, [config?.motion_zones, config?.incursion_line]);

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
  // Bumped on every `seeking` — the seek-reanalysis burst (see runSeekBurst)
  // checks this before each step, so a second seek arriving before the first
  // one's reanalysis finished makes the stale burst abandon itself instead of
  // racing the new one.
  const seekRequestIdRef = useRef(0);
  const [analysisStatus, setAnalysisStatus] = useState<'IDLE' | 'REANALYZING'>('IDLE');

  // Debug snapshot of the last tick's judgment per taxiway — surfaced in the
  // debug panel below (seekRequestId/targetTime/motionScore/.../eventReason).
  // "trackIds" in this system's terms is just which of Z1/Z2/Z3 actually hit
  // this tick — there's no separate multi-object tracker with its own IDs.
  interface RunwayDebugSnapshot {
    motionScore: number;
    motionThreshold: number;
    z1: boolean;
    z2: boolean;
    z3: boolean;
    z3Triggered: boolean;
    z2Motion: boolean;
    runwayHoldingLatched: boolean;
    runwayHoldingState: 'IDLE' | 'ICON_LATCHED' | 'ANIMATING' | 'COMPLETED';
    candidateEvent: RunwayEvent;
    confirmedEvent: RunwayEvent;
    animationType: 'TAKEOFF_CLIMB' | 'RUNWAY_HOLDING_WAIT' | 'NONE';
    eventReason: string;
  }
  const [runwayDebug, setRunwayDebug] = useState<Record<string, RunwayDebugSnapshot>>({});
  const [seekDebug, setSeekDebug] = useState<{ seekRequestId: number; targetTime: number } | null>(null);

  // Single reset point for every piece of per-taxiway temporal state the
  // tick loop accumulates — mirrors the "十、重置函式" list exactly: only
  // clears the transient judgment state used for THIS frame's decision, never
  // the permanent event/audit records (those live server-side and are
  // untouched here).
  const resetTemporalDetectionState = useCallback(() => {
    prevFramesRef.current = new Map();          // 舊的 Motion 狀態（frame-diff baseline）
    z3StreakRef.current = new Map();            // 舊的連續影格計數
    runwayHoldingLatchedRef.current = new Map(); // 舊的鎖存等待狀態 — one of the few things allowed to clear this latch, see its declaration comment
    pendingEventRef.current = new Map();        // 舊的候選事件
    confirmedEventRef.current = new Map();      // 舊的確認事件
    lastTriggerAtRef.current = new Map();       // 舊的事件 Cooldown
    setCurrentStatus(null);                     // 舊的 Icon
    setRunwayDebug({});
  }, []);

  const handleVideoSeeking = useCallback(() => {
    isSeekingRef.current = true;
    seekRequestIdRef.current += 1;
    resetTemporalDetectionState();
    setAnalysisStatus('REANALYZING');
    // 舊的 Track 暫存狀態 — tells AirportSimPanel to drop any LIVE-tracked
    // vehicle and stop whatever animation (起飛/等待) it was mid-playing;
    // this page has no direct handle to that panel, only this socket event.
    getSocket().emit('detector:video-seeking');
  }, [resetTemporalDetectionState]);

  // Server-broadcast when an operator explicitly resets the demo scene (see
  // DetectorAlertService.notifyDemoReset) — one of the few things allowed to
  // clear runwayHoldingLatchedRef (十、鎖存狀態的清除時機). Also emits the
  // same 'detector:video-seeking' AirportSimPanel already listens for, so a
  // demo reset drops any LIVE-tracked vehicle/animation the same way a seek
  // does — a reset invalidates that just as thoroughly as a time jump does.
  useEffect(() => {
    const socket = getSocket();
    const onDemoReset = () => {
      resetTemporalDetectionState();
      socket.emit('detector:video-seeking');
    };
    socket.on('detector:demo-reset', onDemoReset);
    return () => { socket.off('detector:demo-reset', onDemoReset); };
  }, [resetTemporalDetectionState]);

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
  // placeholder (see SimulationEngine.processDetection's snapshotBase64).
  // Capped at 960px wide (not the native frame) to keep the JSON payload a
  // reasonable size; incursion evidence doesn't need full resolution to be
  // useful.
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

  // Extracted from the interval effect below (not just an inline closure) so
  // handleVideoSeeked's reanalysis burst can also call it directly, several
  // times in quick succession, to rebuild z3Triggered/event confirmation
  // faster than waiting out DETECT_INTERVAL_MS-paced ticks. Calling it more
  // than once close together (interval tick + burst overlapping) is safe —
  // it always just samples whatever the CURRENT frame is against whatever
  // baseline is currently stored, nothing here is order- or timing-sensitive
  // beyond that.
  const runDetectionTick = useCallback(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const zones = motionZonesRef.current;
      const incursionLine = incursionLineRef.current;
      if (zones.length === 0 && !incursionLine) {
        setMotionLevel(0);
        return; // nothing configured to scan
      }

      let maxScore = 0;
      // Zones that hit threshold THIS tick — keyed by object identity (a
      // Set), not zone.id, since two different taxiways can each have their
      // own zone reusing the label 'Z1'/'Z2'/'Z3'.
      const hitZones = new Set<DetectorMotionZone>();
      // Raw score per zone this tick — only needed for the debug panel below
      // (seekDebug/runwayDebug), doesn't feed any judgment logic.
      const scoreByZone = new Map<DetectorMotionZone, number>();
      for (const zone of zones) {
        const score = computeZoneScore(video, zone);
        scoreByZone.set(zone, score);
        if (score > maxScore) maxScore = score;
        // Per-zone threshold override (zone.threshold) falls back to the
        // shared default — see DetectorMotionZone's comment.
        if (score >= (zone.threshold ?? motionThresholdRef.current)) {
          // Real-time safety reporting (runway alert + backend incursion
          // pipeline) — deliberately immediate, per-zone, NOT gated behind
          // the event-confirmation logic below. That confirmation exists to
          // stop the ground-sim animation/status text from reacting to a
          // single noisy frame; it must not also delay the actual alert.
          armRunwayAlert();
          reportPlaneDetected('DETECTOR-VIDEO-MOTION', Math.min(0.95, 0.5 + score * 10), zone.taxiway_id, zone.id);
          hitZones.add(zone);
        }
      }

      // ── 事件判定（先完成判定，再播放動畫）────────────────────────────────
      // Collect this tick's COMPLETE zone snapshot per taxiway first — never
      // act on a single zone's hit in isolation. Z1/Z2/Z3 are matched by
      // object identity within that taxiway's own zone list, not a bare id
      // lookup, for the same multi-taxiway reason as hitZones above.
      const zonesByTaxiway = new Map<string, DetectorMotionZone[]>();
      for (const zone of zones) {
        const list = zonesByTaxiway.get(zone.taxiway_id) ?? [];
        list.push(zone);
        zonesByTaxiway.set(zone.taxiway_id, list);
      }

      // "AI 判讀現況" reuses the exact same confirmed event this loop just
      // computed for the ground-sim spawn below — one source of truth for
      // both, instead of two separately-derived readings that can disagree.
      // If more than one taxiway has a confirmed event this tick, shows
      // whichever is furthest along (TAKEOFF > RUNWAY_HOLDING).
      let bestLabel: string | null = null;
      let bestTaxiway: string | null = null;
      let bestRank = -1;
      const nextDebug: Record<string, RunwayDebugSnapshot> = {};

      for (const [taxiwayId, taxiwayZones] of zonesByTaxiway) {
        const z1zone = taxiwayZones.find((z) => z.id === 'Z1');
        const z2zone = taxiwayZones.find((z) => z.id === 'Z2');
        const z3zone = taxiwayZones.find((z) => z.id === 'Z3');
        const z1 = !!z1zone && hitZones.has(z1zone);
        const z2 = !!z2zone && hitZones.has(z2zone);
        const z3 = !!z3zone && hitZones.has(z3zone);

        // Z1 alone is a real detection but deliberately NOT a formal event in
        // determineRunwayEvent (NONE — see its comment/acceptance table,
        // unchanged). Without this, the ground-sim panel would have nothing
        // to show until RUNWAY_HOLDING (needs Z1 AND Z2 in the SAME tick) —
        // and since those zones are normally drawn as physically separate
        // spots along the taxiway, a plane usually leaves Z1's box before
        // ever entering Z2's, so that combination can go long stretches
        // without firing at all and the plane icon just never appears. This
        // is a separate, lighter-weight "a plane showed up" ping — not
        // debounced through EVENT_CONFIRM_TICKS like TAKEOFF/RUNWAY_HOLDING,
        // doesn't touch confirmedEventRef/currentStatus, and can't affect
        // determineRunwayEvent's verdict. Worst case of firing on a single
        // noisy tick is a vehicle appearing slightly early, not a wrong
        // safety verdict; AirportSimPanel's own onField/MIN_SPAWN_GAP_MS
        // checks already make repeat emits a no-op once one vehicle exists.
        if (z1 && !z2 && !z3) {
          getSocket().emit('sim:spawn-at-taxiway', { taxiway_id: taxiwayId, event: 'ENTERING' });
        }

        // 三、Z1＋Z2 Trigger 後鎖存等待 Icon — latches PERMANENTLY the instant
        // Z1 and Z2 have EVER hit together on the same tick; deliberately
        // checked against the RAW z1/z2 (not any confirmed/streak version)
        // since "曾經同時被 Trigger 一次" only needs one real co-occurrence,
        // not sustained motion — sustained motion is z2Motion's job below,
        // which gates the animation, not this latch. Never cleared here —
        // only resetTemporalDetectionState (seek/demo reset) or a fresh
        // TAKEOFF confirmation (a few lines down) may clear it.
        if (z1 && z2) {
          runwayHoldingLatchedRef.current.set(taxiwayId, true);
        }
        const runwayHoldingLatched = runwayHoldingLatchedRef.current.get(taxiwayId) ?? false;

        // Z3 must hit EVENT_CONFIRM_TICKS ticks in a row before it counts as
        // triggered — one frame alone (Z3.motion true but not yet sustained)
        // is never enough on its own (起飛必要條件 / Trigger 與 Motion 的關係).
        const z3Streak = z3 ? (z3StreakRef.current.get(taxiwayId) ?? 0) + 1 : 0;
        z3StreakRef.current.set(taxiwayId, z3Streak);
        const z3Triggered = z3Streak >= EVENT_CONFIRM_TICKS;

        // Z2.motion is NOT "Z2 detected, confirmed over a few ticks" the way
        // z3Triggered is for Z3 — a streak-based confirm can't work here,
        // since Z2 can legitimately keep triggering every single tick (the
        // plane is sitting right there) while genuinely NOT showing "motion"
        // in the stronger sense this needs; a streak would just build up to
        // true within EVENT_CONFIRM_TICKS ticks regardless, making it
        // indistinguishable from Z2.triggered and unable to stay apart from
        // it the way 四、五 requires (顯示Icon但動畫保持不動, sustained, until
        // something ACTUALLY changes). Instead Z2.motion needs a
        // proportionally STRONGER score than Z2.triggered's own threshold —
        // a plane merely present/lingering right at the detection edge
        // trips z2 without necessarily tripping z2Motion; one that's
        // genuinely, actively moving through the zone scores well above it.
        const z2Threshold = z2zone?.threshold ?? motionThresholdRef.current;
        const z2Score = z2zone ? (scoreByZone.get(z2zone) ?? 0) : 0;
        const z2Motion = z2Score >= z2Threshold * Z2_MOTION_THRESHOLD_MULTIPLIER;

        const rawEvent = determineRunwayEvent({ z1, z2, z3, z3Triggered, runwayHoldingLatched, z2Motion });

        // Debounce the FINAL event itself too — must hold for
        // EVENT_CONFIRM_TICKS consecutive ticks before it's accepted, so a
        // combo that flickers between two readings can't restart/switch the
        // animation every tick either. Nothing below this point (status
        // text, sim spawn) reacts until a NEW value survives that window.
        const pending = pendingEventRef.current.get(taxiwayId);
        const pendingCount = pending && pending.event === rawEvent ? pending.count + 1 : 1;
        pendingEventRef.current.set(taxiwayId, { event: rawEvent, count: pendingCount });

        const alreadyConfirmed = confirmedEventRef.current.get(taxiwayId) ?? 'NONE';
        let confirmed = alreadyConfirmed;
        if (pendingCount >= EVENT_CONFIRM_TICKS && alreadyConfirmed !== rawEvent) {
          confirmed = rawEvent;
          confirmedEventRef.current.set(taxiwayId, confirmed);
          // 動畫狀態鎖 — second, explicit check right before this is allowed
          // to trigger the takeoff animation, independent of
          // determineRunwayEvent's own check a few lines up (播放前必須再次
          //檢查). Provably redundant given `confirmed` can only equal
          // 'TAKEOFF' via a rawEvent that already required z3Triggered — kept
          // anyway as a hard, auditable gate so a future edit to
          // determineRunwayEvent (or anything upstream of it) can't silently
          // start the takeoff animation without Z3 actually triggered; fails
          // closed (skips the emit) rather than trusting the caller.
          const takeoffAnimationGateOpen = confirmed !== 'TAKEOFF' || z3Triggered === true;
          // Only TAKEOFF/RUNWAY_HOLDING ever reach the ground-sim — PENDING
          // is icon-only (see determineRunwayEvent's comment): AirportSimPanel
          // never even hears about it, so there is nothing there for it to
          // accidentally animate.
          const isAnimationWorthy = confirmed === 'TAKEOFF' || confirmed === 'RUNWAY_HOLDING';
          if (isAnimationWorthy && takeoffAnimationGateOpen) {
            getSocket().emit('sim:spawn-at-taxiway', { taxiway_id: taxiwayId, event: confirmed });
          }
          // NOT cleared here on TAKEOFF, deliberately — 十、事件優先順序 is
          // explicit that a confirmed TAKEOFF must never accidentally clear
          // the waiting icon's latch just because the takeoff animation
          // started playing (見驗收測試七). 九、鎖存狀態的清除時機 #3 ("系統
          // 明確完成該次等待事件，且確認飛機已離開相關區域") needs actual
          // confirmation the plane left, which TAKEOFF merely STARTING
          // doesn't provide — the plane is still on screen mid-departure.
          // In practice this taxiway's latch clears at the next video loop
          // wrap/seek anyway (handleVideoSeeking already resets it — a
          // <video loop> wrap fires the same native seeking/seeked events as
          // any other jump), which is a reasonable proxy for "this pass of
          // the scene is over" without needing a separate, more fragile
          // "zones have gone quiet" heuristic.
        }

        if (confirmed !== 'NONE') {
          const rank = confirmed === 'TAKEOFF' ? 3 : confirmed === 'RUNWAY_HOLDING' ? 2 : 1;
          if (rank > bestRank) {
            bestRank = rank;
            bestLabel = RUNWAY_EVENT_LABELS[confirmed];
            bestTaxiway = taxiwayId;
          }
        }

        // 八、狀態機 — purely a derived display value for the debug panel, not
        // a separately-maintained state variable (avoids a second source of
        // truth): COMPLETED is only ever visible for the one tick TAKEOFF
        // first confirms, since the latch-clear above already ran by the
        // time this is built; the NEXT tick reads back as IDLE.
        const latchedNow = runwayHoldingLatchedRef.current.get(taxiwayId) ?? false;
        const runwayHoldingState: RunwayDebugSnapshot['runwayHoldingState'] =
          confirmed === 'TAKEOFF' ? 'COMPLETED'
          : !latchedNow ? 'IDLE'
          : confirmed === 'RUNWAY_HOLDING' ? 'ANIMATING'
          : 'ICON_LATCHED';

        nextDebug[taxiwayId] = {
          motionScore: z3zone ? (scoreByZone.get(z3zone) ?? 0) : 0,
          motionThreshold: z3zone?.threshold ?? motionThresholdRef.current,
          z1, z2, z3, z3Triggered,
          z2Motion,
          runwayHoldingLatched: latchedNow,
          runwayHoldingState,
          candidateEvent: rawEvent,
          confirmedEvent: confirmed,
          animationType: confirmed === 'TAKEOFF' ? 'TAKEOFF_CLIMB' : confirmed === 'RUNWAY_HOLDING' ? 'RUNWAY_HOLDING_WAIT' : 'NONE',
          eventReason: confirmed === 'TAKEOFF'
            ? 'Z3_TRIGGERED'
            : confirmed === 'RUNWAY_HOLDING'
              ? 'Z1_Z2_LATCHED_AND_Z2_MOTION'
              : confirmed === 'RUNWAY_HOLDING_PENDING'
                ? `WAITING_FOR_Z2_MOTION (score ${(z2Score * 100).toFixed(1)}% / need ${(z2Threshold * Z2_MOTION_THRESHOLD_MULTIPLIER * 100).toFixed(1)}%)`
                : z3 ? `Z3 detected, awaiting confirm (${z3StreakRef.current.get(taxiwayId) ?? 0}/${EVENT_CONFIRM_TICKS})` : 'NO_CONFIRMED_EVENT',
        };
      }
      setRunwayDebug(nextDebug);
      if (bestLabel && bestTaxiway) {
        setCurrentStatus({ label: bestLabel, taxiwayId: bestTaxiway, at: Date.now() });
      }

      // 跑道入侵線 — same scoring, but never feeds the ground-sim projection
      // (that's Z1/Z2/Z3's job); this is a real safety trigger, so it always
      // grabs a snapshot of the actual frame instead. Backend already checks
      // the taxiway's real authorization state and only latches
      // INCURSION_LATCHED if it wasn't authorized — no separate check needed
      // here, crossing the line just reports "something crossed" the same
      // way any zone does.
      if (incursionLine) {
        const score = computeZoneScore(video, incursionLine);
        if (score > maxScore) maxScore = score;
        if (score >= (incursionLine.threshold ?? motionThresholdRef.current)) {
          armRunwayAlert();
          reportPlaneDetected(
            'DETECTOR-INCURSION-LINE',
            Math.min(0.95, 0.5 + score * 10),
            incursionLine.taxiway_id,
            incursionLine.id,
            captureSnapshot(video),
          );
        }
      }

      setMotionLevel(maxScore);
  }, [computeZoneScore, captureSnapshot, reportPlaneDetected, armRunwayAlert]);

  useEffect(() => {
    if (!motionEnabled) {
      setMotionLevel(0);
      prevFramesRef.current = new Map(); // avoid a stale-diff false trigger on re-enable
      return;
    }
    const intervalId = setInterval(runDetectionTick, DETECT_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [motionEnabled, runDetectionTick]);

  // Several closely-spaced extra runDetectionTick() calls right after a seek
  // completes — rebuilds z3Triggered/event confirmation in well under a
  // second instead of waiting out DETECT_INTERVAL_MS-paced ticks (up to
  // ~2.5s worst case for a fresh TAKEOFF confirmation from a cold reset:
  // EVENT_CONFIRM_TICKS ticks to build z3Triggered, then EVENT_CONFIRM_TICKS
  // more for the final event debounce). Mirrors the spec's
  // SEEK_ANALYSIS_FRAMES idea, implemented by calling the SAME tick function
  // the normal interval uses (not a separate/duplicated analysis path) —
  // extra samples close together are harmless (see runDetectionTick's
  // comment), so this can safely run alongside the normal interval rather
  // than needing to pause/replace it.
  const SEEK_BURST_TICKS = 5;
  const SEEK_BURST_INTERVAL_MS = 120;
  const runSeekBurst = useCallback((requestId: number) => {
    let i = 0;
    const step = () => {
      if (seekRequestIdRef.current !== requestId) return; // superseded by a newer seek — abandon
      runDetectionTick();
      i += 1;
      if (i < SEEK_BURST_TICKS) {
        setTimeout(step, SEEK_BURST_INTERVAL_MS);
      } else if (seekRequestIdRef.current === requestId) {
        isSeekingRef.current = false;
        setAnalysisStatus('IDLE');
      }
    };
    setTimeout(step, SEEK_BURST_INTERVAL_MS);
  }, [runDetectionTick]);

  const handleVideoSeeked = useCallback(() => {
    const requestId = seekRequestIdRef.current;
    setSeekDebug({ seekRequestId: requestId, targetTime: videoRef.current?.currentTime ?? 0 });
    runSeekBurst(requestId);
  }, [runSeekBurst]);

  // ── Motion zone overlay — READ-ONLY on this page. Drawing/editing zones
  // lives on ZoneConfig.tsx ("偵測區域設定") now; this just renders
  // config.motion_zones on top of the live video for visual confirmation of
  // what's currently being scanned, since the actual scanning loop (above)
  // has to stay on this page's always-running <video> regardless.
  const zoneOverlayRef = useRef<HTMLCanvasElement>(null);

  const drawZoneOverlay = useCallback(() => {
    const canvas = zoneOverlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !video.videoWidth) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
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
      const label = ZONE_PHASE_LABELS[zone.id] ? `${zone.id} · ${ZONE_PHASE_LABELS[zone.id]}` : zone.id;
      ctx.fillText(label, rect.x1 + 4, rect.y1 > 16 ? rect.y1 - 4 : rect.y1 + 16);
    });

    // 跑道入侵線 — same red/dashed treatment as ZoneConfig.tsx, so it reads as
    // the safety boundary it is on this page's video too.
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
  }, [config?.motion_zones, config?.incursion_line]);

  useEffect(() => { drawZoneOverlay(); }, [drawZoneOverlay]);

  // ── 3. Manual marks — fires when playback crosses a marked timestamp ────
  const firedThisLoopRef = useRef<Set<number>>(new Set());
  const lastVideoTimeRef = useRef(0);

  const handleVideoTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const t = e.currentTarget.currentTime;
    setCurrentTime(t);
    setPlaybackRate(e.currentTarget.playbackRate);

    if (t < lastVideoTimeRef.current - 1) firedThisLoopRef.current.clear(); // `loop` wrapped back to 0
    lastVideoTimeRef.current = t;

    if (!config) return;
    for (const trigger of config.video_trigger_seconds) {
      if (Math.abs(t - trigger) <= TRIGGER_TOLERANCE_S && !firedThisLoopRef.current.has(trigger)) {
        firedThisLoopRef.current.add(trigger);
        reportPlaneDetected('DETECTOR-VIDEO-MANUAL', 0.95);
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

  // ── Config load/save ──────────────────────────────────────────────────
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

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

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

  if (loading) {
    return <div className="p-6 text-gray-400 text-sm">載入偵測器設定中...</div>;
  }
  if (!config) {
    return <div className="p-6 text-red-400 text-sm">{error ?? '無法載入設定'}</div>;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Crosshair className="w-5 h-5 text-yellow-400" />
            偵測器設定
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Detector Config — 示範影片，AI / 動態 / 手動三重偵測
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
          示範影片來源 · AI / 動態 / 手動偵測
        </h2>
        <div className="flex gap-4">
          {/* Player — synced with LiveMonitor's VideoFeed via useVideoSync */}
          <div className="flex-shrink-0" style={{ width: 640 }}>
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
                  drawZoneOverlay();
                }}
                onTimeUpdate={handleVideoTimeUpdate}
                onSeeking={handleVideoSeeking}
                onSeeked={handleVideoSeeked}
                className="rounded-t border border-gray-800 bg-black block w-full"
              />
              <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              <canvas ref={zoneOverlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
            </div>
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
                <div className="flex items-center gap-1">
                  {SPEED_OPTIONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => applyRate(r)}
                      className="font-mono text-[9px] px-1.5 py-0.5 rounded border transition-colors"
                      style={{
                        background: playbackRate === r ? 'rgba(0,255,136,0.08)' : 'transparent',
                        borderColor: playbackRate === r ? '#00ff88' : '#374151',
                        color: playbackRate === r ? '#00ff88' : '#6b7280',
                      }}
                    >
                      ×{r}
                    </button>
                  ))}
                </div>
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

          {/* Status + controls */}
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

              <Link
                to="/detector/zones"
                className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
              >
                <Frame className="w-3 h-3" />
                管理偵測區域（{config.motion_zones.length}）
              </Link>

              <Link
                to="/detector/zones"
                title="凡未經授權跨越此線，即時拍照存入事件中心"
                className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border transition-colors"
                style={
                  config.incursion_line
                    ? { borderColor: 'rgba(255,68,68,0.3)', background: 'rgba(255,68,68,0.1)', color: '#f87171' }
                    : { borderColor: '#374151', background: 'transparent', color: '#6b7280' }
                }
              >
                <AlertTriangle className="w-3 h-3" />
                跑道入侵線{config.incursion_line ? ` · ${config.incursion_line.taxiway_id}` : '（未設定）'}
              </Link>

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
                  <span className="text-[10px] text-gray-500 shrink-0">觸發門檻</span>
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
                {config.motion_zones.length === 0 ? (
                  <div className="text-[11px] text-gray-600 mt-1.5">
                    尚未設定偵測區域，動態偵測不會掃描任何畫面。前往「
                    <Link to="/detector/zones" className="text-cyan-400 hover:underline">管理偵測區域</Link>
                    」新增。
                  </div>
                ) : (
                  // Read-only — editing lives on the ZoneConfig.tsx page (see
                  // the "管理偵測區域" link above). This just confirms what's
                  // currently being scanned on this page's live video.
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {config.motion_zones.map((zone, i) => (
                      <div
                        key={zone.id}
                        className="flex items-center gap-1.5 px-2 py-1 rounded border text-[11px]"
                        style={{ borderColor: ZONE_COLORS[i % ZONE_COLORS.length] + '55', background: ZONE_COLORS[i % ZONE_COLORS.length] + '14' }}
                      >
                        <span style={{ color: ZONE_COLORS[i % ZONE_COLORS.length] }} className="font-mono">{zone.id}</span>
                        {ZONE_PHASE_LABELS[zone.id] && (
                          <span className="text-gray-600">{ZONE_PHASE_LABELS[zone.id]}</span>
                        )}
                        <span className="text-gray-500 font-mono">{zone.taxiway_id}</span>
                      </div>
                    ))}
                  </div>
                )}
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
              {(seekDebug || Object.keys(runwayDebug).length > 0) && (
                <div className="mt-1 p-2 rounded border border-gray-800 bg-black/30 font-mono text-[10px] text-gray-500 space-y-1">
                  {seekDebug && (
                    <div className="text-gray-600">
                      跳轉除錯 seekRequestId={seekDebug.seekRequestId} · targetTime={formatTime(seekDebug.targetTime)} ({seekDebug.targetTime.toFixed(3)}s)
                    </div>
                  )}
                  {Object.entries(runwayDebug).map(([taxiwayId, d]) => (
                    <div key={taxiwayId} className="text-gray-500 space-y-0.5">
                      <div>
                        {taxiwayId} · motion={(d.motionScore * 100).toFixed(1)}%/{(d.motionThreshold * 100).toFixed(0)}%
                        {' '}· Z1={String(d.z1)} Z2={String(d.z2)} Z3={String(d.z3)}
                      </div>
                      <div>
                        Z3.triggered={String(d.z3Triggered)} · Z2.motion={String(d.z2Motion)}
                        {' '}· runwayHoldingLatched={String(d.runwayHoldingLatched)} · runwayHoldingState={d.runwayHoldingState}
                      </div>
                      <div>
                        candidate={d.candidateEvent} · confirmed={d.confirmedEvent} · animationType={d.animationType}
                        {' '}· {d.eventReason}
                      </div>
                    </div>
                  ))}
                  {Object.keys(runwayDebug).length === 0 && <div className="text-gray-600">尚無任何 taxiway 的判定資料</div>}
                </div>
              )}
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

            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800">
              同一波偵測（不論哪個來源）{(TRIGGER_COOLDOWN_MS / 1000 / playbackRate).toFixed(1)} 秒內只觸發一次（以 20 秒為基準，跟警戒時間一樣依播放速度縮短，避免冷卻時間比警戒時間還長），並自動把跑道保護撥到警戒狀態
              {(RUNWAY_ALERT_DURATION_MS / 1000 / playbackRate).toFixed(1)} 秒（以 30 秒為基準，依目前 ×{playbackRate} 播放速度等比例縮短，
              STM 沒開會先自動開機，期間再偵測到會延長倒數）。
              最後更新：{config.updated_at} · 修改後記得按「儲存」。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
