// 偵測區域設定 — editor for config.motion_zones (Z1/Z2/Z3/...), split out of
// DetectorConfig.tsx so zone calibration has its own page instead of being
// one section buried in the larger detector settings screen.
//
// This page does NOT run any detection itself — the actual motion-scanning
// loop that reads these zones lives in DetectorConfig.tsx, tied to ITS
// <video> element, because that page must keep decoding/scanning in the
// background regardless of which page is visible (see Layout.tsx's
// always-mounted comment). This page is a normal route-driven page (mounts/
// unmounts like EventCenter/AuditLog), so its own <video> here is purely a
// calibration reference — draw a zone, it's saved to the shared
// GET/PUT /api/detector/config the same way DetectorConfig.tsx reads it, and
// takes effect there on the next detection tick regardless of whether this
// page is even open.
//
// Zone semantics (Z1/Z2/Z3 — see ZONE_PHASE_LABELS) are a fixed operator
// convention consumed by AirportSimPanel.spawnAtTaxiway: Z1 進入聯絡道 / Z2
// 跑道頭等待 / Z3 起飛, one plane's three stages. Any zone beyond Z3 has no
// special meaning there — "如果有新的就比照辦理" — new zones just work as
// plain detection regions (same drawing/edit/delete flow), they just don't
// get a phase label chip or any special AirportSimPanel behavior until that
// mapping is extended.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Frame, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { detectorApi } from '../services/api';
import { DetectorConfig, DetectorMotionZone, DetectorRect, ALL_TAXIWAY_IDS } from '../types';
import { useVideoSync } from '../hooks/useVideoSync';

const SPEED_OPTIONS = [1, 2, 3, 5];

// Same downscaled frame-diff sample size as DetectorConfig.tsx's real
// scanning loop — kept identical so a score shown here reads the same as the
// score that page would compute for the same rect, not just a similar-looking
// number.
const MOTION_SAMPLE_W = 160;
const MOTION_SAMPLE_H = 90;
// Purely a calibration readout (no trigger, no cooldown, no alert) — can
// refresh faster than DetectorConfig.tsx's DETECT_INTERVAL_MS (500ms) since
// none of that page's throttling concerns apply here.
const SCORE_TICK_MS = 300;

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

// See the file-level comment above — fixed meaning for exactly Z1/Z2/Z3,
// consumed by AirportSimPanel.spawnAtTaxiway. Not derived from anything;
// this is the single source both that component and this page agree on.
const ZONE_PHASE_LABELS: Record<string, string> = {
  Z1: '進入聯絡道',
  Z2: '跑道頭等待',
  Z3: '起飛',
};

// First 'Z<n>' not already in use — stable even after zones in the middle
// of the list are deleted. New zones (Z4+) get no phase label — "如果有新的
// 就比照辦理" — but the drawing/edit/delete/taxiway-mapping flow is
// identical regardless of id.
function nextZoneId(zones: DetectorMotionZone[]): string {
  const used = new Set(zones.map((z) => z.id));
  let n = 1;
  while (used.has(`Z${n}`)) n++;
  return `Z${n}`;
}

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

// Live 狀態/閥值 readout for one zone — score is this page's own scanning
// loop (see computeZoneScore below), threshold is whatever that zone will
// actually be compared against (its own override, or the shared default).
// Green + filled once score crosses threshold — same "this would fire right
// now" signal the operator is trying to judge while dragging the rect/slider.
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
  const [error, setError] = useState<string | null>(null);

  // Same immediate-persist pattern as DetectorConfig.tsx's persistConfig —
  // drawing a region costs real effort (precise dragging) to redo, so it
  // must never depend on remembering to click a separate save button.
  const persistConfig = useCallback(async (next: DetectorConfig) => {
    setConfig(next);
    try {
      const { frame_w, frame_h, zones, masks, video_trigger_taxiway_id, video_trigger_seconds, motion_zones, motion_threshold, incursion_line } = next;
      const res = await detectorApi.updateConfig({
        frame_w, frame_h, zones, masks, video_trigger_taxiway_id, video_trigger_seconds, motion_zones, motion_threshold, incursion_line,
      });
      setConfig(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '自動儲存失敗，請重新整理後再試一次');
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

  // ── Calibration video — synced with LiveMonitor/DetectorConfig via
  // useVideoSync, same as DetectorConfig.tsx's own player. This page is a
  // normal route (unlike LiveMonitor/DetectorConfig, it's not always
  // mounted — see Layout.tsx), so its <video> is naturally torn down by
  // React Router when the operator navigates away; no manual pause needed.
  const videoRef = useRef<HTMLVideoElement>(null);
  const { publish, debug: syncDebug } = useVideoSync(videoRef);
  const [playbackRate, setPlaybackRate] = useState(3);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const applyRate = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
      publish(rate, videoRef.current.currentTime);
    }
  };

  // ── Live score readout (calibration aid only — no trigger/alert/cooldown,
  // just "would this rect fire right now") ────────────────────────────────
  // Own canvas + baseline map, separate from DetectorConfig.tsx's — that
  // page's baselines are tied to ITS <video> element's frame timing, this
  // page has its own <video> and would get bogus deltas comparing against a
  // baseline captured from a different decode.
  const scoreCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scorePrevFramesRef = useRef<Map<string, Uint8ClampedArray>>(new Map());
  const [zoneScores, setZoneScores] = useState<Record<string, number>>({});

  const computeZoneScore = useCallback((video: HTMLVideoElement, zone: DetectorMotionZone): number => {
    if (!scoreCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = MOTION_SAMPLE_W;
      c.height = MOTION_SAMPLE_H;
      scoreCanvasRef.current = c;
    }
    const canvas = scoreCanvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;

    const { rect } = zone;
    ctx.drawImage(video, rect.x1, rect.y1, rect.x2 - rect.x1, rect.y2 - rect.y1, 0, 0, MOTION_SAMPLE_W, MOTION_SAMPLE_H);
    const frame = ctx.getImageData(0, 0, MOTION_SAMPLE_W, MOTION_SAMPLE_H).data;

    const prev = scorePrevFramesRef.current.get(zone.id);
    if (!prev) {
      scorePrevFramesRef.current.set(zone.id, new Uint8ClampedArray(frame));
      return 0;
    }
    let changed = 0;
    const totalPixels = MOTION_SAMPLE_W * MOTION_SAMPLE_H;
    for (let i = 0; i < frame.length; i += 4) {
      const delta = Math.abs(frame[i] - prev[i]) + Math.abs(frame[i + 1] - prev[i + 1]) + Math.abs(frame[i + 2] - prev[i + 2]);
      if (delta > 60) changed++;
    }
    scorePrevFramesRef.current.set(zone.id, new Uint8ClampedArray(frame));
    return changed / totalPixels;
  }, []);

  useEffect(() => {
    const zones = config?.motion_zones ?? [];
    const line = config?.incursion_line ?? null;
    if (zones.length === 0 && !line) {
      setZoneScores({});
      return;
    }
    scorePrevFramesRef.current = new Map(); // rects changed — old baselines no longer comparable

    const tick = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const next: Record<string, number> = {};
      for (const zone of zones) next[zone.id] = computeZoneScore(video, zone);
      if (line) next[line.id] = computeZoneScore(video, line);
      setZoneScores(next);
    };
    const id = setInterval(tick, SCORE_TICK_MS);
    return () => clearInterval(id);
  }, [config?.motion_zones, config?.incursion_line, computeZoneScore]);

  const seek = (t: number) => {
    setCurrentTime(t);
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      publish(playbackRate, t);
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
  // native resolution — see DetectorConfig.tsx's original comment on this:
  // a drag before the canvas is sized lands nowhere near where it was drawn.
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
            Zone Config — Z1/Z2/Z3 動態偵測區域，實際掃描在「偵測器設定」頁背景執行
          </p>
        </div>
        <button
          onClick={loadConfig}
          className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-300 rounded hover:bg-gray-700 transition-colors text-sm"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          重新載入
        </button>
      </div>

      {error && (
        <div className="mb-4 text-xs text-red-400 bg-red-950/30 border border-red-800 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="flex gap-4">
          {/* Calibration player — bigger than DetectorConfig.tsx's own copy
              (640px) since precise drag-to-draw is the whole point of this
              page; a small preview makes fine region placement hard. */}
          <div className="flex-shrink-0" style={{ width: 960 }}>
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
                  drawRegionOverlay();
                }}
                onTimeUpdate={(e) => {
                  setCurrentTime(e.currentTarget.currentTime);
                  setPlaybackRate(e.currentTarget.playbackRate);
                }}
                className="rounded-t border border-gray-800 bg-black block w-full"
              />
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

          {/* Zone list + controls */}
          <div className="flex-1 min-w-0 space-y-3">
            {/* Shared with DetectorConfig.tsx's config.motion_threshold (persisted)
                — editable here too since this is where the zones themselves are
                being looked at while calibrating. The score readout next to each
                zone below is THIS page's own scan (see computeZoneScore) — close
                to, but not the exact same tick as, DetectorConfig.tsx's real
                scanning loop (different <video> element/decode timing), so treat
                it as "about what it'll do" while calibrating, not a guaranteed
                match to the exact number that page would show at the same instant. */}
            <div>
              <div className="flex items-center gap-2">
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

            {/* 跑道入侵線 — separate, safety-critical trigger: crossing it
                reports a detection the same way any zone does (the backend
                already checks real authorization state and only latches
                INCURSION_LATCHED if it wasn't authorized), but also attaches
                a real camera snapshot to the resulting event instead of a
                generated placeholder image. See DetectorConfig.tsx's
                incursion-line scanning. */}
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

            <div className="text-xs text-gray-600 pt-2 border-t border-gray-800">
              Z1/Z2/Z3 是固定的操作員約定，供 AirportSimPanel（機場地面模擬）判讀一台飛機「進入聯絡道 → 跑道頭等待 → 起飛」三個階段用；Z4 以後的區域一樣能框選、對應聯絡道，只是沒有特殊語意。
              實際的動態偵測開關/門檻在「偵測器設定」頁——這頁只負責區域本身，掃描邏輯不管這頁有沒有開著都會照常在背景執行。
              最後更新：{config.updated_at}。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
