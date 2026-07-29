import React, { useRef, useState } from 'react';
import { useVideoSync } from '../hooks/useVideoSync';

// Loop preview of the detector's demo camera clip (GET /api/detector/video,
// served from server/storage/detector/ — see server/src/routes/
// detectorRoutes.ts) with a small player UI: seek bar + speed buttons.
// Playback position/speed is synced with the Detector Config page's own
// player via useVideoSync (Socket.IO relay) — changing speed or seeking on
// either page moves both. Deliberately has no AI detection logic: that
// lives on DetectorConfig.tsx, which owns the POST /api/demo/detect calls —
// if this component also ran detection, having both pages open at once
// would double-trigger.
const SPEED_OPTIONS = [1, 2, 3, 5];

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function VideoFeed({ className }: { className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { publish } = useVideoSync(videoRef);
  const [playbackRate, setPlaybackRate] = useState(3);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

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

  return (
    <div>
      <video
        ref={videoRef}
        src="/api/detector/video"
        autoPlay
        loop
        muted
        playsInline
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          // Also picks up rate/position changes that arrived via sync from
          // the other page, so the UI (highlighted speed button, seek bar)
          // reflects reality regardless of where the change originated.
          setCurrentTime(e.currentTarget.currentTime);
          setPlaybackRate(e.currentTarget.playbackRate);
        }}
        className={className}
        style={{ width: '100%', display: 'block', background: '#000' }}
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
          </div>
        </div>
      </div>
    </div>
  );
}
