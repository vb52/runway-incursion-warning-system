import { RefObject, useCallback, useEffect, useRef, useState } from 'react';
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

export interface VideoSyncDebug {
  connected: boolean;
  lastSyncAt: number | null; // Date.now() ms of the last *received* (not self-check) sync event
  driftS: number; // currentTime - expected, as of the last check (before correction)
}

const DRIFT_CORRECTION_THRESHOLD_S = 0.15; // only hard-seek past this, so small jitter doesn't stutter playback
const RECHECK_INTERVAL_MS = 1000;

// Module-level (not per-hook-instance) since ZoneConfig.tsx's own
// handleVideoSeeking needs to read this from the SAME <video> this hook is
// driving, regardless of render timing — see its comment below for why this
// exists. Date.now() ms of the last time THIS hook programmatically set
// v.currentTime (a drift correction, not a user action).
let lastProgrammaticSeekAt = 0;

// How large a programmatic drift-correction jump can plausibly be and still
// legitimately be "just us resyncing" rather than something else — no cap in
// practice (a correction after a long buffering stall can be arbitrarily
// large), so this isn't a size check; see handleVideoSeeking's use of
// getLastProgrammaticSeekAt() for the actual timing-window check.
export function getLastProgrammaticSeekAt(): number {
  return lastProgrammaticSeekAt;
}

// ── Local-seek settling ────────────────────────────────────────────────────
// A local seek (operator dragging a seek bar) publishes a new shared epoch,
// but the server echoes it back to EVERY client including the one that sent
// it, and that echo necessarily arrives describing an epoch a round-trip old.
// If the drift check below runs in that gap it "corrects" toward the PRE-seek
// timeline — yanking the picture away from where the operator just put it,
// which publishes again, which echoes again. Both seek bars are
// <input type="range" onChange={...}>, and onChange fires once per drag
// increment, so a single drag used to produce dozens of those rounds.
//
// That tug-of-war is not just cosmetic. Every jump in it is larger than
// ZoneConfig.tsx's SMALL_SEEK_IGNORE_S, so its handleVideoSeeking wiped the
// frame-diff baselines on each one — and a wiped baseline makes
// computeZoneScore cold-start at 0. With this check and the detection tick
// BOTH on a 1000ms period, that meant every single detection pass scored 0:
// no Z1/Z2/Z3 could fire at all, silently, for as long as the tug-of-war
// lasted. Reported as 調整完影像的時間軸，會有一段時間系統無法正常作用.
//
// Fixed in two halves: publishes are debounced so one drag emits once, and
// corrections stand down until the local seek has settled.
const LOCAL_SEEK_SETTLE_MS = 1200;
const PUBLISH_DEBOUNCE_MS = 250;
let lastLocalSeekAt = 0;
let publishTimer: ReturnType<typeof setTimeout> | null = null;

// The single path for "this client's operator moved the playhead". Every seek
// bar goes through here (ZoneConfig's own seek(), VideoFeed's, and the hook's
// returned publish()) so the settle window can never be bypassed by one of
// them emitting 'video:update' directly — which is exactly how VideoFeed's
// bar used to work.
export function publishLocalSeek(currentTime: number, playbackRate = 1): void {
  lastLocalSeekAt = Date.now();
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    // Re-stamped at the moment of the actual emit, not at the first drag
    // increment — the echo we need to stay quiet through lands after THIS.
    lastLocalSeekAt = Date.now();
    getSocket().emit('video:update', { playbackRate, currentTime });
  }, PUBLISH_DEBOUNCE_MS);
}

export function useVideoSync(videoRef: RefObject<HTMLVideoElement>) {
  const stateRef = useRef<VideoSyncState | null>(null);
  const [debug, setDebug] = useState<VideoSyncDebug>({ connected: false, lastSyncAt: null, driftS: 0 });

  useEffect(() => {
    const socket = getSocket();
    const video = videoRef.current;
    let lastSyncAt: number | null = null;

    const applyState = (s: VideoSyncState) => {
      stateRef.current = s;
      const v = videoRef.current;
      let driftS = 0;
      if (v) {
        v.playbackRate = s.playbackRate;
        const duration = v.duration;
        if (duration && isFinite(duration)) {
          const elapsed = ((Date.now() - s.epochTime) / 1000) * s.playbackRate;
          const expected = (((s.epochPosition + elapsed) % duration) + duration) % duration;
          driftS = v.currentTime - expected;
          // Stand down while the operator's own seek is still settling — see
          // publishLocalSeek. The epoch is still recorded above and the drift
          // is still reported to the debug readout; only the correction
          // itself waits, and at most for LOCAL_SEEK_SETTLE_MS, after which
          // the next 1s tick corrects normally.
          const settling = Date.now() - lastLocalSeekAt < LOCAL_SEEK_SETTLE_MS;
          if (Math.abs(driftS) > DRIFT_CORRECTION_THRESHOLD_S && !settling) {
            // Tagged with a timestamp (not a plain boolean — the native
            // 'seeking' event this triggers dispatches asynchronously, so a
            // synchronous "set true, assign, set false" flag could clear
            // before the listener ever reads it) so
            // ZoneConfig.tsx's handleVideoSeeking can recognize "this seek
            // was OUR OWN resync, not the operator dragging the bar" even
            // when the jump is large (e.g. after a long initial-buffering
            // stall, drift can exceed several seconds) — see that function's
            // comment for why misclassifying this as a real seek was wiping
            // in-flight aircraft events/vehicles.
            lastProgrammaticSeekAt = Date.now();
            v.currentTime = expected;
          }
        }
      }
      setDebug({ connected: socket.connected, lastSyncAt, driftS });
    };

    const onSync = (s: VideoSyncState) => {
      lastSyncAt = Date.now();
      applyState(s);
    };
    const onLoadedMetadata = () => { if (stateRef.current) applyState(stateRef.current); };

    socket.on('video:sync', onSync);
    video?.addEventListener('loadedmetadata', onLoadedMetadata);
    socket.emit('video:request-state');

    // video plays on its own between syncs; this just nudges it back in
    // line if it's drifted (buffering stalls, background-tab throttling).
    const driftInterval = setInterval(() => {
      if (stateRef.current) applyState(stateRef.current);
    }, RECHECK_INTERVAL_MS);

    return () => {
      socket.off('video:sync', onSync);
      video?.removeEventListener('loadedmetadata', onLoadedMetadata);
      clearInterval(driftInterval);
    };
  }, [videoRef]);

  // Call when the LOCAL user changes speed or seeks — broadcasts the new
  // reference point so every other connected tab/page snaps to match.
  // Delegates to publishLocalSeek so it picks up the debounce and the settle
  // window (see there); the argument order is kept for its existing callers.
  const publish = useCallback((playbackRate: number, currentTime: number) => {
    publishLocalSeek(currentTime, playbackRate);
  }, []);

  return { publish, debug };
}
