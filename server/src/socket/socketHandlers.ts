import { Server as SocketIOServer, Socket } from 'socket.io';
import { systemStateService } from '../services/SystemStateService';
import { videoSyncService } from '../services/VideoSyncService';
import { detectorAlertService } from '../services/DetectorAlertService';
import { logger } from '../utils/logger';

// INTEGRATION: Register all socket event handlers here.
// Client connects and receives initial system state.

export function setupSocketHandlers(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    const clientId = socket.id;
    logger.info(`[SOCKET] Client connected: ${clientId}`);

    // Send current system state on connection
    const state = systemStateService.getSystemState();
    socket.emit('system:state-updated', { systemState: state });

    // Send current video playback reference point too (see VideoSyncService)
    // so a newly-opened tab/page catches up to what's already playing
    // elsewhere instead of starting its own <video> at 0.
    socket.emit('video:sync', videoSyncService.getState());

    // Detector runway-alert countdown (see DetectorAlertService) — send
    // current state so a newly-opened tab shows the right countdown (or
    // none) immediately instead of assuming idle.
    const alertState = detectorAlertService.getState();
    if (alertState.alertUntil !== null) {
      socket.emit('detector:alert-armed', alertState);
    }

    socket.on('disconnect', (reason) => {
      logger.info(`[SOCKET] Client disconnected: ${clientId} (reason: ${reason})`);
    });

    // Client can request state refresh
    socket.on('system:request-state', () => {
      const currentState = systemStateService.getSystemState();
      socket.emit('system:state-updated', { systemState: currentState });
    });

    // Video sync: a client requesting a catch-up (e.g. on mount), or
    // publishing a new reference point (speed change / seek) that every
    // other connected client — including other pages/tabs — should adopt.
    socket.on('video:request-state', () => {
      socket.emit('video:sync', videoSyncService.getState());
    });

    socket.on('video:update', (payload: { playbackRate?: number; currentTime?: number }) => {
      if (typeof payload?.playbackRate !== 'number' || typeof payload?.currentTime !== 'number') return;
      videoSyncService.setState(payload.playbackRate, payload.currentTime);
    });

    // ZoneConfig.tsx's activeAircraftEventsRef state machine advancing a
    // taxiway's AircraftEvent -> spawn/advance a matching vehicle in
    // AirportSimPanel (client/src/pages/LiveMonitor.tsx listens for this),
    // so a real video detection visibly shows up in the ground-sim diagram
    // instead of the two staying visually disconnected. Pure relay, no
    // server-side state — momentary visual event, nothing to replay to a
    // late-joining client.
    socket.on('sim:spawn-at-taxiway', (payload: { taxiway_id?: string; event?: string }) => {
      if (typeof payload?.taxiway_id !== 'string') return;
      // Respect the same grace window as arm() (see DetectorAlertService.
      // isSuppressed/suppress) — right after an operator RESET or manual
      // system start, a detector-triggered spawn would otherwise call
      // AirportSimPanel.spawnAtTaxiway(), which auto-starts the ground-sim
      // loop the instant it arrives, undoing the "clean" reset the operator
      // just asked for just as surely as an immediate RWY re-arm would.
      if (detectorAlertService.isSuppressed()) return;
      // ENTERING (Z1 creates a new AircraftEvent — the only event that may
      // spawn a fresh vehicle), RUNWAY_HOLDING (Z2 binds to that event, entry
      // animation plays), or TAKEOFF (Z3 motion confirmed + entry animation
      // completed) — see ZoneConfig.tsx's AircraftEvent state machine. Each
      // is a one-time transition already fully judged there, never
      // re-derived or re-interpreted here.
      if (payload.event !== 'TAKEOFF' && payload.event !== 'RUNWAY_HOLDING' && payload.event !== 'ENTERING') return;
      io.emit('sim:spawn-at-taxiway', { taxiway_id: payload.taxiway_id, event: payload.event });
    });

    // ZoneConfig.tsx's source video jumped to a different time (seek bar
    // drag, click-to-seek, or a programmatic currentTime change from any
    // page — see that file's handleVideoSeeking). Every taxiway's Z1/Z2/Z3
    // state at the OLD time point is now meaningless, so tell AirportSimPanel
    // to drop any LIVE-tracked vehicle (and whatever animation it was mid-
    // playing) rather than let it keep going as if nothing happened. Pure
    // relay, no server-side state — same momentary-event shape as
    // sim:spawn-at-taxiway above.
    socket.on('detector:video-seeking', () => {
      io.emit('detector:video-seeking');
    });

    // AirportSimPanel.tsx reports back once a LIVE-tracked vehicle's own
    // animation actually reaches the runway-head position (simStep's
    // TAXI_OUT -> AT_JUNCTION transition) — ZoneConfig.tsx's
    // activeAircraftEventsRef state machine uses this to know the entry
    // animation genuinely finished (real animation-timing knowledge only
    // AirportSimPanel has), gating takeoff on it so it can never start while
    // that animation is still visibly playing. Pure relay, no server-side
    // state — same momentary-event shape as sim:spawn-at-taxiway above.
    socket.on('sim:aircraft-at-runway-head', (payload: { taxiway_id?: string }) => {
      if (typeof payload?.taxiway_id !== 'string') return;
      io.emit('sim:aircraft-at-runway-head', { taxiway_id: payload.taxiway_id });
    });

    // AirportSimPanel.tsx reports back once a LIVE-tracked vehicle's takeoff
    // animation actually completes — ZoneConfig.tsx clears that taxiway's
    // AircraftEvent so a genuinely later, new Z1 detection (a second plane
    // departing from the same taxiway later in the same video loop) can
    // start a fresh event instead of being blocked for the rest of the
    // session. Pure relay, no server-side state.
    socket.on('sim:aircraft-departed', (payload: { taxiway_id?: string }) => {
      if (typeof payload?.taxiway_id !== 'string') return;
      io.emit('sim:aircraft-departed', { taxiway_id: payload.taxiway_id });
    });

    // DEBUG: Ping/pong for connection testing
    socket.on('ping:test', () => {
      socket.emit('pong:test', { timestamp: new Date().toISOString() });
    });
  });

  logger.info('[SOCKET] Socket.IO handlers registered.');
}
