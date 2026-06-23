// Simple structured logger for RIWS server
// INTEGRATION: Replace with Winston or Pino for production

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): LogLevel {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  return LEVEL_PRIORITY[level] !== undefined ? level : 'info';
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  const configuredLevel = getConfiguredLevel();
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[configuredLevel]) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

  if (meta !== undefined) {
    console.log(`${prefix} ${message}`, meta);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => log('debug', message, meta),
  info: (message: string, meta?: unknown) => log('info', message, meta),
  warn: (message: string, meta?: unknown) => log('warn', message, meta),
  error: (message: string, meta?: unknown) => log('error', message, meta),
};
