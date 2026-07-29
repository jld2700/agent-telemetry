/**
 * Agent Telemetry — Logger
 *
 * Minimal structured logger (no external dependency).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function format(level: LogLevel, msg: string, ctx?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const ctxStr = ctx ? ` ${JSON.stringify(ctx)}` : '';
  return `[${ts}] ${level.toUpperCase()} ${msg}${ctxStr}`;
}

export const logger = {
  debug(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog('debug')) console.debug(format('debug', msg, ctx));
  },
  info(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog('info')) console.info(format('info', msg, ctx));
  },
  warn(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog('warn')) console.warn(format('warn', msg, ctx));
  },
  error(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog('error')) console.error(format('error', msg, ctx));
  },
};
