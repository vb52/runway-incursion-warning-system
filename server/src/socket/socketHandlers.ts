import { Server as SocketIOServer, Socket } from 'socket.io';
import { systemStateService } from '../services/SystemStateService';
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

    socket.on('disconnect', (reason) => {
      logger.info(`[SOCKET] Client disconnected: ${clientId} (reason: ${reason})`);
    });

    // Client can request state refresh
    socket.on('system:request-state', () => {
      const currentState = systemStateService.getSystemState();
      socket.emit('system:state-updated', { systemState: currentState });
    });

    // DEBUG: Ping/pong for connection testing
    socket.on('ping:test', () => {
      socket.emit('pong:test', { timestamp: new Date().toISOString() });
    });
  });

  logger.info('[SOCKET] Socket.IO handlers registered.');
}
