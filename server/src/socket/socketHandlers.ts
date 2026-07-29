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

    // Motion-zone hit in the detector engine (client/src/hooks/
    // useDetectorEngine.ts) -> spawn a one-shot vehicle at that taxiway in
    // AirportSimPanel (client/src/pages/LiveMonitor.tsx listens for this),
    // so a real video detection visibly shows up in the ground-sim diagram
    // instead of the two staying visually disconnected. Pure relay, no
    // server-side state — momentary visual event, nothing to replay to a
    // late-joining client.
    socket.on('sim:spawn-at-taxiway', (payload: { taxiway_id?: string }) => {
      if (typeof payload?.taxiway_id !== 'string') return;
      io.emit('sim:spawn-at-taxiway', { taxiway_id: payload.taxiway_id });
    });

    // DEBUG: Ping/pong for connection testing
    socket.on('ping:test', () => {
      socket.emit('pong:test', { timestamp: new Date().toISOString() });
    });
  });

  logger.info('[SOCKET] Socket.IO handlers registered.');
}
