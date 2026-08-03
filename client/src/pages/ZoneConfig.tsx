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
import { DetectorConfig, DetectorMotionZone, DetectorRect, ALL_TAXIWAY_IDS } from '../types';
import { useVideoSync } from '../hooks/useVideoSync';
import { useDetectorAlert } from '../hooks/useDetectorAlert';
import { getSocket } from '../services/socketService';
import { setDetectorVideoElement } from '../services/detectorVideoRegistry';
import { useAppStore } from '../stores/appStore';

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

const SPEED_OPTIONS = [1, 2, 3, 5];

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

// ── 飛機事件狀態機（單一物件，每條聯絡道一台飛機）─────────────────────────
// Replaces the old independent-latch model (每個判定各自維護自己的
// latch/streak，RUNWAY_HOLDING 和 TAKEOFF 各自都能在沒有追蹤到飛機時「補
// spawn」一台) — that's what let a plane's FIRST ever appearance on a taxiway
// come from RUNWAY_HOLDING or TAKEOFF instead of ENTERING (e.g. Z1's box is
// brief enough, or physically close enough to Z2's, that the plain-Z1 tick
// never happens), spawning it directly at/near the runway threshold with no
// visible taxi run at all, then departing moments later — reads exactly like
// 「一進跑道就起飛」even though every individual latch was behaving exactly
// as designed. See AirportSimPanel.spawnAtTaxiway — RUNWAY_HOLDING/TAKEOFF
// no longer ever create a vehicle, only advance an already-tracked one.
//
// Z1 is now the ONLY thing that may create an event (and therefore, via
// spawnAtTaxiway's ENTERING branch, the only thing that may cause a new
// vehicle to appear). Z2/Z3 only ever ADVANCE an existing event; if none
// exists yet for a taxiway, they're simply ignored — physically, Z2/Z3
// firing without Z1 ever having been seen means the pipeline missed
// something, not that a second, independent plane appeared.
// No separate "Z1 detected, waiting for Z2" state — Z1 creates the event
// directly in ENTERING_RUNWAY_HEAD (see the tick loop) since stage 1->2 no
// longer waits for real Z2 evidence, only a short bounded pause on the
// AirportSimPanel side ("Z1/Z2 停一秒直接進").
//
// UP TO TWO concurrent events per taxiway (operator request: "支援兩台，Z1
// 直接開第二個就好") — a real Z1 hit while an existing event is still
// ENTERING_RUNWAY_HEAD (not yet physically at the runway head) is almost
// certainly the SAME plane and is ignored, same as before; but once that
// event reaches HOLDING_AT_RUNWAY_HEAD or TAKING_OFF — meaning it's
// physically clear of Z1's zone, since a plane can't be at Z1 and at/near
// the runway head simultaneously — a new Z1 hit unambiguously means a
// SECOND, independent plane, and gets its own event. This structurally
// caps concurrency to at most one event still "in transit" (ENTERING_
// RUNWAY_HEAD, entryAnimationCompleted false) plus at most one "ahead"
// event (HOLDING_AT_RUNWAY_HEAD or TAKING_OFF) at a time — see the tick
// loop's creation check. Z2/Z3 raw hits are single per-tick signals (not
// tied to a specific vehicle by the video itself), so they're targeted at
// whichever event's STATE makes it the sensible recipient (the in-transit
// one for Z2's catch-up effect, the holding one for Z3) rather than by an
// explicit id — see the tick loop and evaluateTakeoff.
type AircraftEventState = 'ENTERING_RUNWAY_HEAD' | 'HOLDING_AT_RUNWAY_HEAD' | 'TAKING_OFF';

const AIRCRAFT_STATE_LABELS: Record<AircraftEventState, string> = {
  ENTERING_RUNWAY_HEAD: '前往跑道頭',
  HOLDING_AT_RUNWAY_HEAD: '跑道頭等待',
  TAKING_OFF: '起飛',
};

// Held in activeAircraftEventsRef as Map<taxiwayId, AircraftEvent[]> (see
// that ref's declaration) — up to two entries per taxiway, see
// AircraftEventState's comment. entryAnimationCompleted is NOT decided in
// this file — it's reported back by AirportSimPanel via
// 'sim:aircraft-at-runway-head' once the tracked vehicle's OWN animation
// actually reaches the runway-head position, since that's real animation-
// timing knowledge only that component has. Takeoff is gated on that flag
// specifically so it can never start while the entering animation is still
// visibly playing — see evaluateTakeoff below for the "Z3 confirms early,
// deferred until entry finishes" case.
interface AircraftEvent {
  state: AircraftEventState;
  entryAnimationPlayed: boolean;
  entryAnimationCompleted: boolean;
  z3MotionFrameCount: number;
  z3MotionConfirmed: boolean;
  takeoffAnimationPlayed: boolean;
}

// Consecutive detection ticks (DETECT_INTERVAL_MS apart) Z3 must hold before
// its motion counts as confirmed — one noisy frame is never enough on its
// own to start a takeoff. 3 ticks @ 500ms = 1.5s. Only ever accumulated once
// the plane has ACTUALLY, physically arrived at the runway head
// (entryAnimationCompleted — see the tick loop) — Z3 motion before that, or
// with no active event for that taxiway at all, means nothing and starts
// nothing. Even once confirmed, evaluateTakeoff still separately requires
// state === HOLDING_AT_RUNWAY_HEAD before it actually starts a takeoff.
const Z3_MOTION_CONFIRM_FRAMES = 3;

// Per-event debug fields shown in the debug panel below — one taxiway can
// hold up to two concurrent AircraftEvents (see activeAircraftEventsRef's
// comment), so this is nested inside RunwayDebugSnapshot as an array rather
// than being flattened into it directly.
interface AircraftEventDebug {
  state: AircraftEventState;
  entryAnimationCompleted: boolean;
  z3MotionFrameCount: number;
  z3MotionConfirmed: boolean;
  takeoffAnimationPlayed: boolean;
  eventReason: string;
}

// Debug snapshot of the last tick's judgment per taxiway — surfaced in the
// debug panel below. z1/z2/z3 are this tick's raw zone hits (there's no
// separate multi-object tracker with its own IDs in this system — one
// frame-diff score vs threshold per zone is the only signal).
interface RunwayDebugSnapshot {
  motionScore: number;
  motionThreshold: number;
  z1: boolean;
  z2: boolean;
  z3: boolean;
  events: AircraftEventDebug[];
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
  // Default 3x — the source clip is mostly idle taxiing, 3x keeps demo
  // pacing tighter without needing a shorter/edited source file.
  const [playbackRate, setPlaybackRate] = useState(3);
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
  // Operator-drawn zones (config.motion_zones) — kept in a ref so the tick
  // loop doesn't need `config` as a dep (avoids restarting the detection
  // interval on every unrelated config edit).
  const motionZonesRef = useRef<DetectorMotionZone[]>([]);
  // The single 跑道入侵線 (config.incursion_line) — kept separate from
  // motionZonesRef since it's scored the same way but handled differently on
  // a hit (real snapshot, no ground-sim projection).
  const incursionLineRef = useRef<DetectorMotionZone | null>(null);
  // Up to two AircraftEvents per taxiway currently tracking a plane (see
  // AircraftEventState's comment) — the single source of truth the tick loop
  // below reads and mutates. All reset together whenever zones are redrawn,
  // since an event built against the old zone layout isn't meaningful once
  // the rects (and what they mean) have changed.
  const activeAircraftEventsRef = useRef<Map<string, AircraftEvent[]>>(new Map());

  useEffect(() => {
    motionZonesRef.current = config?.motion_zones ?? [];
    incursionLineRef.current = config?.incursion_line ?? null;
    prevFramesRef.current = new Map(); // zone set/rects changed — old baselines no longer comparable
    activeAircraftEventsRef.current = new Map();
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
  // Bumped on every `seeking` — the seek-reanalysis burst (see runSeekBurst)
  // checks this before each step, so a second seek arriving before the first
  // one's reanalysis finished makes the stale burst abandon itself instead of
  // racing the new one.
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
    lastTriggerAtRef.current = new Map();       // 舊的事件 Cooldown
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

    isSeekingRef.current = true;
    seekRequestIdRef.current += 1;
    resetTemporalDetectionState();
    setAnalysisStatus('REANALYZING');
    // 舊的 Track 暫存狀態 — tells AirportSimPanel to drop any LIVE-tracked
    // vehicle and stop whatever animation (起飛/等待) it was mid-playing.
    getSocket().emit('detector:video-seeking');
  }, [resetTemporalDetectionState]);

  // Server-broadcast when an operator explicitly resets the demo scene (see
  // DetectorAlertService.notifyDemoReset) — one of the few things allowed to
  // clear activeAircraftEventsRef. Also emits the same
  // 'detector:video-seeking' AirportSimPanel already listens for, so a demo
  // reset drops any LIVE-tracked vehicle/animation the same way a seek does.
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

  // Extracted from the interval effect below (not just an inline closure) so
  // handleVideoSeeked's reanalysis burst can also call it directly, several
  // times in quick succession, to rebuild z3Triggered/event confirmation
  // faster than waiting out DETECT_INTERVAL_MS-paced ticks. Calling it more
  // than once close together (interval tick + burst overlapping) is safe —
  // it always just samples whatever the CURRENT frame is against whatever
  // baseline is currently stored, nothing here is order- or timing-sensitive
  // beyond that.
  const emitSpawn = useCallback((taxiwayId: string, event: 'TAKEOFF' | 'RUNWAY_HOLDING' | 'ENTERING') => {
    getSocket().emit('sim:spawn-at-taxiway', { taxiway_id: taxiwayId, event });
  }, []);

  // Starts TAKING_OFF for whichever of this taxiway's events is holding at
  // the runway head and has every precondition met — called both from the
  // tick loop (right after updating Z3's confirmation streak) and from
  // maybeEnterHolding below (the case where Z3 motion confirmed WHILE the
  // entry animation was still playing: z3MotionConfirmed gets recorded
  // early, but entryAnimationCompleted was still false, so nothing fired
  // yet — once it flips true, this same check now passes). At most one
  // event should ever be HOLDING_AT_RUNWAY_HEAD at a time (see
  // AircraftEventState's comment on the concurrency cap), so `find` rather
  // than iterating all matches is intentional, not a shortcut. Safe to call
  // unconditionally; no-ops unless every condition holds. This is the ONLY
  // place a TAKEOFF spawn is ever emitted.
  const evaluateTakeoff = useCallback((taxiwayId: string) => {
    const events = activeAircraftEventsRef.current.get(taxiwayId);
    if (!events) return;
    const event = events.find((e) =>
      e.state === 'HOLDING_AT_RUNWAY_HEAD' &&
      e.entryAnimationCompleted &&
      e.z3MotionConfirmed &&
      !e.takeoffAnimationPlayed
    );
    if (event) {
      event.state = 'TAKING_OFF';
      event.takeoffAnimationPlayed = true;
      emitSpawn(taxiwayId, 'TAKEOFF');
    }
  }, [emitSpawn]);

  // entryAnimationCompleted (AirportSimPanel's own vehicle animation
  // actually reached the runway-head position — see simStep's TAXI_OUT/
  // TAXI_TO_HEAD cases) is real animation-timing evidence only that
  // component has; this side's own state (ENTERING_RUNWAY_HEAD from the
  // moment Z1 creates the event, per "Z1/Z2 停一秒直接進") isn't a reliable
  // proxy for "has it actually arrived" anymore. HOLDING_AT_RUNWAY_HEAD may
  // only start once entryAnimationCompleted is confirmed true — takes the
  // specific event directly (found by the caller — see onArrived below,
  // the only caller) rather than re-deriving which one, since with up to
  // two events per taxiway "the one that just reported arrival" isn't
  // otherwise recoverable from the taxiway id alone.
  const maybeEnterHolding = useCallback((taxiwayId: string, event: AircraftEvent) => {
    if (
      event.entryAnimationCompleted &&
      event.state !== 'HOLDING_AT_RUNWAY_HEAD' &&
      event.state !== 'TAKING_OFF'
    ) {
      event.state = 'HOLDING_AT_RUNWAY_HEAD';
      evaluateTakeoff(taxiwayId);
    }
  }, [evaluateTakeoff]);

  // AirportSimPanel reports back once a LIVE-tracked vehicle's own animation
  // actually reaches the runway-head position — this is the only place
  // entryAnimationCompleted may become true, since only that component
  // knows when its own animation has actually finished. The vehicle that
  // just arrived can only be the "in transit" one — the only event that's
  // still ENTERING_RUNWAY_HEAD with entryAnimationCompleted still false;
  // structurally there's at most one such event per taxiway at a time (see
  // AircraftEventState's concurrency-cap comment), so finding it this way
  // is unambiguous without needing an explicit per-vehicle id. Ignored if no
  // such event exists (e.g. a seek already cleared it, or a stale/duplicate
  // signal after it was already recorded).
  useEffect(() => {
    const socket = getSocket();
    const onArrived = (data: { taxiway_id?: string }) => {
      if (typeof data?.taxiway_id !== 'string') return;
      const events = activeAircraftEventsRef.current.get(data.taxiway_id);
      const event = events?.find((e) => e.state !== 'TAKING_OFF' && !e.entryAnimationCompleted);
      if (!event) return;
      event.entryAnimationCompleted = true;
      maybeEnterHolding(data.taxiway_id, event);
    };
    socket.on('sim:aircraft-at-runway-head', onArrived);
    return () => { socket.off('sim:aircraft-at-runway-head', onArrived); };
  }, [maybeEnterHolding]);

  // AirportSimPanel reports back once a LIVE-tracked vehicle's takeoff
  // animation actually completes (simState -> 'DONE') — removes JUST that
  // one event from this taxiway's array (not the whole taxiway — the other
  // slot, if any, may still have a second plane mid-sequence) so a LATER,
  // genuinely new Z1 detection can start a fresh event instead of being
  // permanently blocked for the rest of the session. At most one event
  // should ever be TAKING_OFF at a time (see AircraftEventState's
  // concurrency-cap comment), so removing all TAKING_OFF entries is
  // equivalent to removing the one that just departed. Per the operator's
  // spec, an event may only ever be removed by: this (takeoff animation
  // completing), RESET, a video seek, or a demo reset — never by a timer,
  // and never just because Z1/Z2/Z3 signals momentarily drop out.
  useEffect(() => {
    const socket = getSocket();
    const onDeparted = (data: { taxiway_id?: string }) => {
      if (typeof data?.taxiway_id !== 'string') return;
      const events = activeAircraftEventsRef.current.get(data.taxiway_id);
      if (!events) return;
      const remaining = events.filter((e) => e.state !== 'TAKING_OFF');
      if (remaining.length > 0) activeAircraftEventsRef.current.set(data.taxiway_id, remaining);
      else activeAircraftEventsRef.current.delete(data.taxiway_id);
    };
    socket.on('sim:aircraft-departed', onDeparted);
    return () => { socket.off('sim:aircraft-departed', onDeparted); };
  }, []);

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
      // Raw score per zone this tick — feeds both the debug panel and the
      // live ZoneScoreBadge readouts below.
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
          // mayCreate is true only for Z1 — "TRIGGER自動警戒一定要Z1觸發，
          // 只有告警觸發後Z2/Z3延長": Z2/Z3 (and any zone beyond Z3) may only
          // extend an alert Z1 already started, never begin a fresh one on
          // their own. Non-Z1/Z2/Z3 zones (a plain detection region with no
          // special taxi-sequence meaning) default to extend-only too, same
          // reasoning as Z2/Z3.
          const mayCreate = zone.id === 'Z1';
          armRunwayAlert(mayCreate);
          reportPlaneDetected('DETECTOR-VIDEO-MOTION', Math.min(0.95, 0.5 + score * 10), zone.taxiway_id, zone.id, undefined, mayCreate);
          hitZones.add(zone);
        }
      }

      // ── 事件判定：Z1/Z2/Z3 整合為同一架飛機的完整事件狀態機 ────────────────
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

      // "AI 判讀現況" reuses the exact same event state this loop just
      // updated — one source of truth, instead of two separately-derived
      // readings that can disagree. If more than one taxiway has an active
      // event this tick, shows whichever is furthest along.
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

        // Z1 creates a NEW event if either (a) no event exists yet for this
        // taxiway, or (b) every existing event has already reached
        // HOLDING_AT_RUNWAY_HEAD/TAKING_OFF — physically clear of Z1's zone,
        // since a plane can't be at Z1 and at/near the runway head at the
        // same time (operator request: "支援兩台，Z1直接開第二個就好" — see
        // AircraftEventState's concurrency-cap comment). Z1 later dropping
        // back to false never clears anything — nothing here ever deletes an
        // existing entry; only 'sim:aircraft-departed' (takeoff animation
        // finished) or resetTemporalDetectionState (seek/RESET/demo reset)
        // do. Starts directly in ENTERING_RUNWAY_HEAD with
        // entryAnimationPlayed=true — operator request ("Z1/Z2 停一秒直接
        // 進"): stage 1->2 no longer waits for real Z2 evidence, only
        // AirportSimPanel's own bounded 1-second pause (see that file's
        // TAXI_OUT case), so there's no separate "waiting for Z2" state to
        // model here anymore. Real Z2 hits still matter below — they extend
        // the alert and accelerate an already-playing animation — they just
        // no longer gate whether stage 2 starts at all. Takeoff (Z3) is
        // unaffected by any of this — still strictly evidence-gated, see
        // evaluateTakeoff.
        const existingEvents = activeAircraftEventsRef.current.get(taxiwayId) ?? [];
        const hasInTransitEvent = existingEvents.some((e) => e.state !== 'HOLDING_AT_RUNWAY_HEAD' && e.state !== 'TAKING_OFF');
        if (z1 && !hasInTransitEvent) {
          activeAircraftEventsRef.current.set(taxiwayId, [
            ...existingEvents,
            {
              state: 'ENTERING_RUNWAY_HEAD',
              entryAnimationPlayed: true,
              entryAnimationCompleted: false,
              z3MotionFrameCount: 0,
              z3MotionConfirmed: false,
              takeoffAnimationPlayed: false,
            },
          ]);
          emitSpawn(taxiwayId, 'ENTERING');
        }

        const events = activeAircraftEventsRef.current.get(taxiwayId) ?? [];

        if (events.length > 0) {
          // Real Z2 evidence, whenever it does arrive, still accelerates an
          // already-playing stage-1/stage-2 animation (AirportSimPanel's
          // RUNWAY_HOLDING handler sets headPending/catchUp on whichever
          // tracked vehicle is still in transit) — idempotent, safe to emit
          // every tick Z2 is hit, same as ENTERING's repeat pings. No longer
          // gates anything on this side; it just no longer creates a second
          // event either (only Z1 ever does, above).
          if (z2) {
            emitSpawn(taxiwayId, 'RUNWAY_HOLDING');
          }

          // 只要有進行中的事件（尚未起飛），就持續延長告警 — not just whenever
          // Z1/Z2's own raw score happens to still be above threshold THIS
          // tick (the earlier per-zone loop's job). The plane physically
          // leaves each zone's box well before the animation (or the wait at
          // the runway head) finishes, so relying on a zone staying hit
          // would let the alert window quietly expire mid-animation. Any
          // active, not-yet-departed event is itself real, still-valid
          // evidence a plane is in transit. mayCreate=false (extend only) —
          // this may never START a fresh alert on its own, per "TRIGGER自動
          // 警戒一定要Z1觸發，只有告警觸發後Z2/Z3延長".
          if (events.some((e) => e.state !== 'TAKING_OFF')) {
            armRunwayAlert(false);
          }

          for (const event of events) {
            // Z3 motion confirmation — only accumulated once THIS event's
            // plane has ACTUALLY, physically arrived at the runway head
            // (entryAnimationCompleted, reported by AirportSimPanel — real
            // animation-timing evidence, not just this side's own state,
            // which can now reach ENTERING_RUNWAY_HEAD almost immediately
            // after Z1 thanks to the bounded pause above). Gating on
            // entryAnimationCompleted specifically (rather than state) keeps
            // Z3 from ever pre-accumulating confirm-ticks before the plane
            // is genuinely there — a hit before that point means the zones
            // overlap or are miscalibrated, not that the plane is genuinely
            // near takeoff, and letting it pre-accumulate is what caused
            // "Z3/Z2 被同時觸發是起飛" (instant takeoff, no visible pause at
            // the runway head) before this gate existed. With up to two
            // events active, this naturally only ever matters for whichever
            // one has already arrived — a second, still-in-transit event's
            // count simply stays at 0.
            if (event.entryAnimationCompleted && event.state !== 'TAKING_OFF') {
              event.z3MotionFrameCount = z3 ? event.z3MotionFrameCount + 1 : 0;
              if (event.z3MotionFrameCount >= Z3_MOTION_CONFIRM_FRAMES) event.z3MotionConfirmed = true;
            }
          }

          evaluateTakeoff(taxiwayId);

          // "AI 判讀現況" shows whichever of this taxiway's (up to two)
          // events is furthest along.
          for (const event of events) {
            const rank = event.state === 'TAKING_OFF' ? 4
              : event.state === 'HOLDING_AT_RUNWAY_HEAD' ? 3
              : 2; // ENTERING_RUNWAY_HEAD — the only remaining state
            if (rank > bestRank) {
              bestRank = rank;
              bestLabel = AIRCRAFT_STATE_LABELS[event.state];
              bestTaxiway = taxiwayId;
            }
          }
        }

        nextDebug[taxiwayId] = {
          motionScore: z3zone ? (scoreByZone.get(z3zone) ?? 0) : 0,
          motionThreshold: z3zone?.threshold ?? motionThresholdRef.current,
          z1, z2, z3,
          events: events.map((event) => ({
            state: event.state,
            entryAnimationCompleted: event.entryAnimationCompleted,
            z3MotionFrameCount: event.z3MotionFrameCount,
            z3MotionConfirmed: event.z3MotionConfirmed,
            takeoffAnimationPlayed: event.takeoffAnimationPlayed,
            eventReason: event.state === 'ENTERING_RUNWAY_HEAD'
              ? `ENTERING_ANIMATION_PLAYING (entryAnimationCompleted=${String(event.entryAnimationCompleted)}, Z3 motion ${event.z3MotionFrameCount}/${Z3_MOTION_CONFIRM_FRAMES}${event.z3MotionConfirmed ? '，已提前確認，等進入動畫播完才起飛' : ''})`
              : event.state === 'HOLDING_AT_RUNWAY_HEAD'
                ? `HOLDING_AT_RUNWAY_HEAD (Z3 motion ${event.z3MotionFrameCount}/${Z3_MOTION_CONFIRM_FRAMES})`
                : 'TAKEOFF_ANIMATION_PLAYING',
          })),
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
        scoreByZone.set(incursionLine, score);
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

      // Live per-zone score readout for ZoneScoreBadge — same measurement
      // just taken above for real judgment, keyed by zone.id for the UI.
      const nextZoneScores: Record<string, number> = {};
      for (const [zone, score] of scoreByZone) nextZoneScores[zone.id] = score;
      setZoneScores(nextZoneScores);

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
  // ~2.5s worst case for a fresh TAKEOFF confirmation from a cold reset).
  // Implemented by calling the SAME tick function the normal interval uses
  // (not a separate/duplicated analysis path) — extra samples close together
  // are harmless, so this can safely run alongside the normal interval
  // rather than needing to pause/replace it.
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
                      {taxiwayId} · motion={(d.motionScore * 100).toFixed(1)}%/{(d.motionThreshold * 100).toFixed(0)}%
                      {' '}· Z1={String(d.z1)} Z2={String(d.z2)} Z3={String(d.z3)} · {d.events.length} 台飛機
                    </div>
                    {d.events.map((e, i) => (
                      <div key={i} className="pl-2 border-l border-gray-800">
                        <div>
                          #{i + 1} state={e.state} · entryAnimationCompleted={String(e.entryAnimationCompleted)}
                        </div>
                        <div>
                          z3MotionFrameCount={e.z3MotionFrameCount} · z3MotionConfirmed={String(e.z3MotionConfirmed)}
                          {' '}· takeoffAnimationPlayed={String(e.takeoffAnimationPlayed)}
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

            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800">
              Z1/Z2/Z3 是固定的操作員約定，供 AirportSimPanel（機場地面模擬）判讀一台飛機「進入聯絡道 → 跑道頭等待 → 起飛」三個階段用；Z4 以後的區域一樣能框選、對應聯絡道，只是沒有特殊語意。
              同一波偵測（不論哪個來源）{(TRIGGER_COOLDOWN_MS / 1000 / playbackRate).toFixed(1)} 秒內只觸發一次，並自動把跑道保護撥到警戒狀態
              {(RUNWAY_ALERT_DURATION_MS / 1000 / playbackRate).toFixed(1)} 秒（依目前 ×{playbackRate} 播放速度等比例縮短，STM 沒開會先自動開機）。
              最後更新：{config.updated_at} · 修改後記得按「儲存」。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
