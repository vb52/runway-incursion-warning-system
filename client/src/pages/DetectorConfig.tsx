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
//      「偵測區域」（config.motion_zones——按「新增偵測區域」拖曳畫出，跟舊的
//      Zone 編輯器一樣的拖曳互動；每個區域各自獨立比對、各自對應自己的
//      taxiway_id，例如 Z1 框住某個聯絡道口、Z2 框住另一個，各自觸發各自的
//      滑行道，不像 AI/手動標記共用同一個「觸發聯絡道」下拉選單），再縮小到
//      MOTION_SAMPLE_W x MOTION_SAMPLE_H 比對像素差異量，概念上對應 RIWS-POC
//      桌面版用 cv2.createBackgroundSubtractorMOG2() 補捉 YOLO 漏掉的角度。
//      不特別分辨「是不是飛機」，區域內任何明顯移動都算，所以框選範圍很重要——
//      沒有設定任何區域就完全不會掃描（不會退回掃整個畫面），框住跑道/聯絡道口
//      才準確。有獨立開關可以整個關掉。
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
// 兩邊完全不受 RESET（LiveMonitor.tsx handleFullReset）影響：RESET 只重置後端
// 系統狀態/事件跟 AirportSimPanel 的模擬車隊，從沒碰過 <video> 元素本身。
//
// 跑道警戒倒數（armRunwayAlert）也是伺服器端狀態（server/src/services/
// DetectorAlertService.ts），不是這頁自己算自己的 setTimeout——這樣「主戰情表」
// 才能顯示同一個倒數，而不是只有觸發偵測的那個分頁看得到。

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Crosshair, Save, RefreshCw, Play, Loader2, Plane, Trash2, RotateCcw } from 'lucide-react';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { detectorApi, demoApi } from '../services/api';
import { DetectorConfig, DetectorMotionZone, DetectorRect, ALL_TAXIWAY_IDS } from '../types';
import { useVideoSync } from '../hooks/useVideoSync';
import { useDetectorAlert } from '../hooks/useDetectorAlert';

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
// adjustable at runtime (see motionThreshold state below) — it was a fixed
// 0.02 originally and turned out to fire too easily (compression noise/small
// background movement), so it's a live slider now instead of another guess
// at a magic number.
const MOTION_SAMPLE_W = 160;
const MOTION_SAMPLE_H = 90;
const DEFAULT_MOTION_THRESHOLD = 0.06;
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

// First 'Z<n>' not already in use — stable even after zones in the middle
// of the list are deleted.
function nextZoneId(zones: DetectorMotionZone[]): string {
  const used = new Set(zones.map((z) => z.id));
  let n = 1;
  while (used.has(`Z${n}`)) n++;
  return `Z${n}`;
}

export function DetectorConfigPage() {
  const [config, setConfig] = useState<DetectorConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const { frame_w, frame_h, zones, masks, video_trigger_taxiway_id, video_trigger_seconds, motion_zones } = next;
      const res = await detectorApi.updateConfig({
        frame_w, frame_h, zones, masks, video_trigger_taxiway_id, video_trigger_seconds, motion_zones,
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
  const lastTriggerAtRef = useRef(0); // Date.now() ms, for TRIGGER_COOLDOWN_MS
  // Kept in a ref (not read from `config` inside the detect loops) so a
  // config edit elsewhere on this page doesn't restart the loops.
  const taxiwayIdRef = useRef('1S');

  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [lastDetection, setLastDetection] = useState<{ score: number; at: string; source: string } | null>(null);
  const [triggerCount, setTriggerCount] = useState(0);
  const [rawPredictions, setRawPredictions] = useState<cocoSsd.DetectedObject[]>([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [motionLevel, setMotionLevel] = useState(0);
  const [motionThreshold, setMotionThreshold] = useState(DEFAULT_MOTION_THRESHOLD);
  // Read inside the tick's setInterval closure via a ref so dragging the
  // slider doesn't tear down/rebuild the detection interval on every change.
  const motionThresholdRef = useRef(motionThreshold);
  useEffect(() => { motionThresholdRef.current = motionThreshold; }, [motionThreshold]);

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
  const reportPlaneDetected = useCallback(async (source: string, confidence: number, taxiwayId?: string) => {
    // Scaled by playback speed, same as the runway alert window — otherwise
    // at e.g. 3x the cooldown (20s fixed) outlasts the alert window (10s),
    // leaving a dead zone where the runway has already gone back to
    // unarmed but new detections are still being suppressed.
    const scaledCooldownMs = TRIGGER_COOLDOWN_MS / playbackRateRef.current;
    const now = Date.now();
    if (now - lastTriggerAtRef.current < scaledCooldownMs) return;
    lastTriggerAtRef.current = now;
    setTriggerCount((c) => c + 1);
    setLastDetection({ score: confidence, at: new Date().toLocaleTimeString('zh-TW', { hour12: false }), source });

    await armRunwayAlert();
    demoApi.detect({
      taxiway_id: taxiwayId ?? taxiwayIdRef.current,
      target_type: 'AIRCRAFT',
      confidence,
      entering_runway: true,
      camera_id: source,
    }).catch(() => {
      // Can still fail (e.g. RWY enable itself failed) — stay quiet.
    });
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
    if (modelStatus !== 'ready' || !aiEnabled) {
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
  }, [modelStatus, aiEnabled, drawOverlay, reportPlaneDetected, armRunwayAlert]);

  // ── 2. Motion detection (frame-diff, independent of the AI model) ───────
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // One diff baseline per zone (keyed by zone id) — each zone crops a
  // different part of the frame, so they can't share a single baseline.
  const prevFramesRef = useRef<Map<string, Uint8ClampedArray>>(new Map());
  // Operator-drawn zones (config.motion_zones) — see the drawing UI below.
  // Kept in a ref so the tick loop doesn't need `config` as a dep (avoids
  // restarting the detection interval on every unrelated config edit).
  const motionZonesRef = useRef<DetectorMotionZone[]>([]);

  useEffect(() => {
    motionZonesRef.current = config?.motion_zones ?? [];
    prevFramesRef.current = new Map(); // zone set/rects changed — old baselines no longer comparable
  }, [config?.motion_zones]);

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

  useEffect(() => {
    if (!motionEnabled) {
      setMotionLevel(0);
      prevFramesRef.current = new Map(); // avoid a stale-diff false trigger on re-enable
      return;
    }

    const tick = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const zones = motionZonesRef.current;
      if (zones.length === 0) {
        setMotionLevel(0);
        return; // nothing configured to scan
      }

      let maxScore = 0;
      for (const zone of zones) {
        const score = computeZoneScore(video, zone);
        if (score > maxScore) maxScore = score;
        if (score >= motionThresholdRef.current) {
          // Same as the AI tick: reset the alert window every time motion is
          // still seen, independent of reportPlaneDetected's event cooldown.
          armRunwayAlert();
          reportPlaneDetected('DETECTOR-VIDEO-MOTION', Math.min(0.95, 0.5 + score * 10), zone.taxiway_id);
        }
      }
      setMotionLevel(maxScore);
    };

    const intervalId = setInterval(tick, DETECT_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [motionEnabled, computeZoneScore, reportPlaneDetected, armRunwayAlert]);

  // ── Motion region drawing (drag a rect on the video, like the old Zone
  // editor) ─────────────────────────────────────────────────────────────
  const regionCanvasRef = useRef<HTMLCanvasElement>(null);
  const [drawingRegion, setDrawingRegion] = useState(false);
  const regionDragRef = useRef<{ active: boolean; x1: number; y1: number; x2: number; y2: number }>({
    active: false, x1: 0, y1: 0, x2: 0, y2: 0,
  });

  // Keeps the region canvas's internal pixel buffer matched to the video's
  // native resolution. Called from both drawRegionOverlay (rendering) and
  // regionCanvasPos (mouse-to-video coordinate conversion) so the canvas can
  // never be read/drawn against a stale size — that mismatch is exactly what
  // caused a drawn region to save the wrong rect (canvas defaults to 300x150
  // until something resizes it; if a drag starts before that happens, the
  // saved coordinates come out scaled against 300x150 instead of the real
  // e.g. 1920x1080, landing nowhere near where the operator actually dragged).
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
      ctx.fillText(`${zone.id} · ${zone.taxiway_id}`, rect.x1 + 4, rect.y1 > 16 ? rect.y1 - 4 : rect.y1 + 16);
    });

    if (regionDragRef.current.active) {
      const drag = normalizeRect(regionDragRef.current.x1, regionDragRef.current.y1, regionDragRef.current.x2, regionDragRef.current.y2);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(drag.x1, drag.y1, drag.x2 - drag.x1, drag.y2 - drag.y1);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(drag.x1, drag.y1, drag.x2 - drag.x1, drag.y2 - drag.y1);
    }
  }, [config?.motion_zones, ensureRegionCanvasSized]);

  useEffect(() => { drawRegionOverlay(); }, [drawRegionOverlay]);

  const regionCanvasPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Defensive resize right before reading position — see
    // ensureRegionCanvasSized's comment for why this can't be skipped.
    const canvas = ensureRegionCanvasSized() ?? regionCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const onRegionMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingRegion) return;
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
    const newZone: DetectorMotionZone = {
      id: nextZoneId(config.motion_zones),
      rect: r,
      taxiway_id: config.video_trigger_taxiway_id,
    };
    persistConfig({ ...config, motion_zones: [...config.motion_zones, newZone] });
    setDrawingRegion(false);
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
                ref={videoRef}
                src="/api/detector/video"
                autoPlay
                loop
                muted
                playsInline
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration || 0);
                  // Size the region canvas to the video's native resolution
                  // as soon as we know it — without this, the FIRST drag
                  // (before metadata loads) computes mouse coordinates
                  // against the canvas's default 300x150 buffer instead of
                  // the real video size, saving a region that doesn't match
                  // what was visually drawn at all. See drawRegionOverlay.
                  drawRegionOverlay();
                }}
                onTimeUpdate={handleVideoTimeUpdate}
                className="rounded-t border border-gray-800 bg-black block w-full"
              />
              <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              <canvas
                ref={regionCanvasRef}
                onMouseDown={onRegionMouseDown}
                onMouseMove={onRegionMouseMove}
                onMouseUp={onRegionMouseUp}
                className="absolute inset-0 w-full h-full"
                style={{ pointerEvents: drawingRegion ? 'auto' : 'none', cursor: drawingRegion ? 'crosshair' : 'default' }}
              />
            </div>
            {drawingRegion && (
              <div className="text-[10px] text-cyan-400 mt-1">拖曳畫出動態偵測範圍，放開滑鼠確認</div>
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

              <button
                onClick={() => setDrawingRegion((v) => !v)}
                className="px-2 py-1 rounded text-[11px] border transition-colors"
                style={
                  drawingRegion
                    ? { borderColor: '#00c8ff', background: 'rgba(0,200,255,0.15)', color: '#00c8ff' }
                    : { borderColor: '#374151', background: 'transparent', color: '#9ca3af' }
                }
              >
                {drawingRegion ? '框選中...' : '新增偵測區域'}
              </button>

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
                <div className="h-1.5 rounded bg-gray-800 overflow-hidden" title={`動態偵測門檻 ${(motionThreshold * 100).toFixed(0)}%`}>
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${Math.min(100, (motionLevel / (motionThreshold * 3)) * 100)}%`,
                      background: motionLevel >= motionThreshold ? '#00c8ff' : '#374151',
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
                    value={motionThreshold}
                    onChange={(e) => setMotionThreshold(parseFloat(e.target.value))}
                    className="w-full h-1 accent-cyan-400 cursor-pointer"
                  />
                  <span className="font-mono text-[10px] text-gray-500 shrink-0 w-9 text-right">
                    {(motionThreshold * 100).toFixed(0)}%
                  </span>
                </div>
                {config.motion_zones.length === 0 ? (
                  <div className="text-[11px] text-gray-600 mt-1.5">尚未設定偵測區域，動態偵測不會掃描任何畫面。</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {config.motion_zones.map((zone, i) => (
                      <div
                        key={zone.id}
                        className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded border text-[11px]"
                        style={{ borderColor: ZONE_COLORS[i % ZONE_COLORS.length] + '55', background: ZONE_COLORS[i % ZONE_COLORS.length] + '14' }}
                      >
                        <span style={{ color: ZONE_COLORS[i % ZONE_COLORS.length] }} className="font-mono">{zone.id}</span>
                        <select
                          value={zone.taxiway_id}
                          onChange={(e) => setMotionZoneTaxiway(zone.id, e.target.value)}
                          className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-gray-300"
                        >
                          {ALL_TAXIWAY_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
                        </select>
                        <button onClick={() => removeMotionZone(zone.id)} className="text-gray-600 hover:text-red-400">
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
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
