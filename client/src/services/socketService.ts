import { io, Socket } from 'socket.io-client';
import { SystemState, RiwsEvent, VlmAnalysis } from '../types';

// INTEGRATION: Socket.IO client connects to the RIWS backend.
// All real-time state updates flow through this service.

const SOCKET_URL = typeof window !== 'undefined'
  ? window.location.origin
  : 'http://localhost:3001';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Type-safe event subscription helpers
export interface SocketCallbacks {
  onSystemStateUpdated?: (data: { systemState: SystemState }) => void;
  onRunwayStateUpdated?: (data: { runwayProtectionState: string }) => void;
  onTaxiwayStateUpdated?: (data: { taxiway: { id: string; state: string } }) => void;
  onEventCreated?: (data: { event: RiwsEvent }) => void;
  onEventUpdated?: (data: { event: RiwsEvent }) => void;
  onVlmUpdated?: (data: { eventId: string; analysis: VlmAnalysis }) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onConnectError?: (error: Error) => void;
}

export function registerSocketCallbacks(callbacks: SocketCallbacks): () => void {
  const s = getSocket();

  if (callbacks.onSystemStateUpdated) {
    s.on('system:state-updated', callbacks.onSystemStateUpdated);
  }
  if (callbacks.onRunwayStateUpdated) {
    s.on('runway:state-updated', callbacks.onRunwayStateUpdated);
  }
  if (callbacks.onTaxiwayStateUpdated) {
    s.on('taxiway:state-updated', callbacks.onTaxiwayStateUpdated);
  }
  if (callbacks.onEventCreated) {
    s.on('event:created', callbacks.onEventCreated);
  }
  if (callbacks.onEventUpdated) {
    s.on('event:updated', callbacks.onEventUpdated);
  }
  if (callbacks.onVlmUpdated) {
    s.on('vlm:updated', callbacks.onVlmUpdated);
  }
  if (callbacks.onConnect) {
    s.on('connect', callbacks.onConnect);
  }
  if (callbacks.onDisconnect) {
    s.on('disconnect', callbacks.onDisconnect);
  }
  if (callbacks.onConnectError) {
    s.on('connect_error', callbacks.onConnectError);
  }

  // Return cleanup function
  return () => {
    if (callbacks.onSystemStateUpdated) s.off('system:state-updated', callbacks.onSystemStateUpdated);
    if (callbacks.onRunwayStateUpdated) s.off('runway:state-updated', callbacks.onRunwayStateUpdated);
    if (callbacks.onTaxiwayStateUpdated) s.off('taxiway:state-updated', callbacks.onTaxiwayStateUpdated);
    if (callbacks.onEventCreated) s.off('event:created', callbacks.onEventCreated);
    if (callbacks.onEventUpdated) s.off('event:updated', callbacks.onEventUpdated);
    if (callbacks.onVlmUpdated) s.off('vlm:updated', callbacks.onVlmUpdated);
    if (callbacks.onConnect) s.off('connect', callbacks.onConnect);
    if (callbacks.onDisconnect) s.off('disconnect', callbacks.onDisconnect);
    if (callbacks.onConnectError) s.off('connect_error', callbacks.onConnectError);
  };
}
