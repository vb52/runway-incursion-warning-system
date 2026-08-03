import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { getSocket } from '../services/socketService';
import { getDetectorVideoElement, onDetectorVideoElementChange } from '../services/detectorVideoRegistry';

// Loop preview of the detector's demo camera clip — mirrors ZoneConfig.tsx's
// own <video> element via canvas instead of owning a second independent
// decode of the same ~330MB source. That page's video can never pause (its
// detection loops depend on it decoding continuously in the background), so
// it's always the one paying the real decode cost; this component just
// copies its current frame onto a canvas every animation frame, which is
// close to free by comparison. See detectorVideoRegistry.ts for why this
// exists — an earlier version had its own <video src=...> here, which meant
// two full decodes running at once any time the operator was actually on
// 主戰情表 (this page), the most common place to notice choppy playback.
//
// Because there's no local <video> element anymore, seeking/changing speed
// from this page acts directly on the shared element (ZoneConfig.tsx's),
// then broadcasts the change via Socket.IO the same way it always did — that
// page's own useVideoSync instance is what actually keeps the shared element
// drift-corrected; this component only reads from it and forwards operator
// input to it.
const SPEED_OPTIONS = [1, 2, 3, 5];

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function VideoFeed({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const [playbackRate, setPlaybackRate] = useState(3);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [connected, setConnected] = useState(false);

  // LiveMonitor (this component's only caller) stays mounted even when
  // another page is showing (see Layout.tsx), so the mirror loop below only
  // needs to run while this page is actually the visible one.
  const location = useLocation();
  const isVisible = location.pathname === '/' || location.pathname === '/monitor';

  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    setConnected(socket.connected);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, []);

  // Mirror loop — only while visible, since there's nothing to show
  // otherwise and no reason to spend even the cheap drawImage cost.
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      // readyState check matters, not just videoWidth: videoWidth becomes
      // non-zero at HAVE_METADATA, but drawImage needs HAVE_CURRENT_DATA
      // (>=2) or it throws InvalidStateError — which, uncaught, would abort
      // this function before the requestAnimationFrame(draw) call below ever
      // runs, permanently killing the mirror loop after a single bad frame
      // (e.g. right at mount, or right after reloadVideo()'s video.load()
      // resets the shared element back to HAVE_NOTHING). Wrapped in try/catch
      // too so any other transient decode error can't do the same.
      const source = getDetectorVideoElement();
      const canvas = canvasRef.current;
      if (source && canvas && source.videoWidth && source.readyState >= 2) {
        if (canvas.width !== source.videoWidth || canvas.height !== source.videoHeight) {
          canvas.width = source.videoWidth;
          canvas.height = source.videoHeight;
        }
        try {
          canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
        } catch {
          // skip this frame, try again next tick
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelled = true; cancelAnimationFrame(rafRef.current); };
  }, [isVisible]);

  // currentTime/duration/playbackRate readout for the seek bar + speed
  // buttons — listens directly on whichever element is currently registered
  // (re-attaches if that ever changes, see onDetectorVideoElementChange).
  useEffect(() => {
    let cleanup = () => {};
    const attach = (video: HTMLVideoElement | null) => {
      if (!video) { cleanup = () => {}; return; }
      const onTime = () => {
        setCurrentTime(video.currentTime);
        setPlaybackRate(video.playbackRate);
      };
      const onMeta = () => setDuration(video.duration || 0);
      video.addEventListener('timeupdate', onTime);
      video.addEventListener('loadedmetadata', onMeta);
      if (video.duration) setDuration(video.duration);
      onTime();
      cleanup = () => {
        video.removeEventListener('timeupdate', onTime);
        video.removeEventListener('loadedmetadata', onMeta);
      };
    };
    attach(getDetectorVideoElement());
    const unsubscribe = onDetectorVideoElementChange((el) => {
      cleanup();
      attach(el);
    });
    return () => { cleanup(); unsubscribe(); };
  }, []);

  const applyRate = (rate: number) => {
    const video = getDetectorVideoElement();
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackRate(rate);
    getSocket().emit('video:update', { playbackRate: rate, currentTime: video.currentTime });
  };

  const seek = (t: number) => {
    const video = getDetectorVideoElement();
    if (!video) return;
    video.currentTime = t;
    setCurrentTime(t);
    getSocket().emit('video:update', { playbackRate: video.playbackRate, currentTime: t });
  };

  // Reloads the actual shared source (ZoneConfig.tsx's <video>) — fixes
  // this preview AND detection at once now, instead of just a local copy
  // that was never the real problem for either.
  const reloadVideo = () => {
    const video = getDetectorVideoElement();
    if (!video) return;
    video.load();
    video.play().catch(() => {});
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        className={className}
        style={{ width: '100%', display: 'block', background: '#000', aspectRatio: '16 / 9' }}
      />
      <div className="px-2 py-1.5 bg-[#0a0a0a] border-t border-[#1e1e1e]">
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
            <button
              onClick={reloadVideo}
              title="影片畫面卡住時點這裡重新載入"
              className="flex items-center gap-1 font-mono text-[9px] px-1.5 py-0.5 rounded border border-[#374151] text-[#6b7280] hover:text-gray-300 hover:border-gray-500 transition-colors"
            >
              <RefreshCw className="w-2.5 h-2.5" />
              重新載入
            </button>
          </div>
        </div>
        <div className="mt-1 font-mono text-[9px] text-gray-600">
          同步：{connected ? <span className="text-green-500">連線中</span> : <span className="text-red-500">未連線</span>}
        </div>
      </div>
    </div>
  );
}
