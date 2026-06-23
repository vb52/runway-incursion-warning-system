import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';

import { initDb } from './database/db';
import { systemStateService } from './services/SystemStateService';
import { eventService } from './services/EventService';
import { vlmService } from './vlm/VlmService';
import { simulationEngine } from './simulation/SimulationEngine';
import { setupSocketHandlers } from './socket/socketHandlers';

import systemRoutes from './routes/systemRoutes';
import runwayRoutes from './routes/runwayRoutes';
import taxiwayRoutes from './routes/taxiwayRoutes';
import eventRoutes from './routes/eventRoutes';
import vlmRoutes from './routes/vlmRoutes';
import vlmHealthRoutes from './routes/vlmHealthRoutes';
import auditRoutes from './routes/auditRoutes';
import demoRoutes from './routes/demoRoutes';
import healthRoutes from './routes/healthRoutes';
import mediaRoutes from './routes/mediaRoutes';

import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const NODE_ENV = process.env.NODE_ENV ?? 'development';

async function main() {
  logger.info('[SERVER] Starting RIWS server...');

  // Initialize database
  initDb();

  // Create Express app
  const app = express();
  const httpServer = createServer(app);

  // SECURITY: Configure CORS for development
  const corsOrigins = NODE_ENV === 'production'
    ? [process.env.CLIENT_URL ?? 'http://localhost:5173']
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];

  app.use(cors({
    origin: corsOrigins,
    credentials: true,
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging (DEBUG)
  if (process.env.DEBUG_MODE === 'true') {
    app.use((req, _res, next) => {
      logger.debug(`${req.method} ${req.path}`);
      next();
    });
  }

  // Initialize Socket.IO
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Wire up services with Socket.IO
  systemStateService.setSocketIO(io);
  eventService.setSocketIO(io);
  vlmService.setSocketIO(io);
  simulationEngine.setSocketIO(io);

  // Setup socket handlers
  setupSocketHandlers(io);

  // ── API Routes ─────────────────────────────────────────────────────────────
  app.use('/api/health', healthRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/runway', runwayRoutes);
  app.use('/api/taxiways', taxiwayRoutes);
  app.use('/api/events', eventRoutes);
  // VLM routes: event-scoped
  app.use('/api/events', vlmRoutes);
  // VLM health endpoint
  app.use('/api/vlm', vlmHealthRoutes);
  app.use('/api/audit-logs', auditRoutes);
  app.use('/api/demo', demoRoutes);
  app.use('/api/media', mediaRoutes);

  // API 404 handler
  app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, error: 'API endpoint not found.' });
  });

  // Serve static client files in production
  if (NODE_ENV === 'production') {
    const clientDist = path.join(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('[SERVER] Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  });

  // Start listening
  httpServer.listen(PORT, () => {
    logger.info(`[SERVER] RIWS Server running on http://localhost:${PORT}`);
    logger.info(`[SERVER] Environment: ${NODE_ENV}`);
    logger.info(`[SERVER] VLM Provider: ${vlmService.getProviderInfo().name}`);
    logger.info('[SERVER] Ready to accept connections.');
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('[SERVER] Received SIGINT. Shutting down gracefully...');
    httpServer.close(() => {
      logger.info('[SERVER] HTTP server closed.');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    logger.info('[SERVER] Received SIGTERM. Shutting down gracefully...');
    httpServer.close(() => {
      process.exit(0);
    });
  });
}

main().catch((err) => {
  logger.error('[SERVER] Fatal startup error:', err);
  process.exit(1);
});
