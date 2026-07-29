import { RefObject, useCallback, useEffect, useRef } from 'react';
import { getSocket } from '../services/socketService';

// Keeps a <video> element's playbackRate/currentTime in step with every
// other page/tab that also uses this hook (LiveMonitor's VideoFeed,
// DetectorConfig's calibration player), via a shared reference point relayed
// through Socket.IO (server/src/services/VideoSyncService.ts) — not a video
// stream, just { playbackRate, epochPosition, epochTime }. Each client
// derives its own expected currentTime from wall-clock elapsed time since
// epochTime, so no continuous traffic is needed between syncs.
interface VideoSyncState {
  playbackRate: number;
  epochPosition: number;
  epochTime: number;
}

const DRIFT_CORRECTION_THRESHOLD_S = 0.5; // only hard-seek past this, so small jitter doesn't stutter playback

export function useVideoSync(videoRef: RefObject<HTMLVideoElement>) {
  const stateRef = useRef<VideoSyncState | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const video = videoRef.current;

    const applyState = (s: VideoSyncState) => {
      stateRef.current = s;
      const v = videoRef.current;
      if (!v) return;
      v.playbackRate = s.playbackRate;
      const duration = v.duration;
      if (!duration || !isFinite(duration)) return; // metadata not loaded yet — loadedmetadata listener below retries
      const elapsed = ((Date.now() - s.epochTime) / 1000) * s.playbackRate;
      const expected = (((s.epochPosition + elapsed) % duration) + duration) % duration;
      if (Math.abs(v.currentTime - expected) > DRIFT_CORRECTION_THRESHOLD_S) {
        v.currentTime = expected;
      }
    };

    const onSync = (s: VideoSyncState) => applyState(s);
    const onLoadedMetadata = () => { if (stateRef.current) applyState(stateRef.current); };

    socket.on('video:sync', onSync);
    video?.addEventListener('loadedmetadata', onLoadedMetadata);
    socket.emit('video:request-state');

    // video plays on its own between syncs; this just nudges it back in
    // line if it's drifted (buffering stalls, background-tab throttling).
    const driftInterval = setInterval(() => {
      if (stateRef.current) applyState(stateRef.current);
    }, 5000);

    return () => {
      socket.off('video:sync', onSync);
      video?.removeEventListener('loadedmetadata', onLoadedMetadata);
      clearInterval(driftInterval);
    };
  }, [videoRef]);

  // Call when the LOCAL user changes speed or seeks — broadcasts the new
  // reference point so every other connected tab/page snaps to match.
  const publish = useCallback((playbackRate: number, currentTime: number) => {
    getSocket().emit('video:update', { playbackRate, currentTime });
  }, []);

  return { publish };
}
