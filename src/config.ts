/**
 * Agent Telemetry — Configuration
 *
 * Configuration can come from:
 * 1. A config file (agent-telemetry.toml or .json) in the data directory
 * 2. Environment variables (AGENT_TELEMETRY_*)
 * 3. Programmatic API (when used as a library)
 */

export interface TelemetryConfig {
  /** Data directory for SQLite DB and logs */
  dataDir: string;

  /** HTTP server settings */
  server: {
    host: string;
    port: number;
  };

  /** Upstream reporting target (e.g. dcc-service, custom backend) */
  upstream?: {
    url: string;
    /** Optional auth token for upstream API */
    token?: string;
  };

  /** Langfuse forwarding (OTLP reviver) */
  langfuse?: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
  };

  /** Reporter intervals (ms) */
  intervals: {
    logEvents: number;
    metrics: number;
  };

  /** Logging level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_CONFIG: TelemetryConfig = {
  dataDir: `${process.env.HOME}/.agent-telemetry`,
  server: {
    host: '127.0.0.1',
    port: 9911,
  },
  intervals: {
    logEvents: 10 * 60 * 1000, // 10 min
    metrics: 10 * 60 * 1000, // 10 min
  },
  logLevel: 'info',
};

/**
 * Load config from environment variables + optional config file.
 * Env vars use AGENT_TELEMETRY_ prefix.
 */
export function loadConfig(overrides?: Partial<TelemetryConfig>): TelemetryConfig {
  const env = process.env;

  const config: TelemetryConfig = {
    ...DEFAULT_CONFIG,
    dataDir: env.AGENT_TELEMETRY_DATA_DIR ?? DEFAULT_CONFIG.dataDir,
    server: {
      host: env.AGENT_TELEMETRY_HOST ?? DEFAULT_CONFIG.server.host,
      port: Number.parseInt(env.AGENT_TELEMETRY_PORT ?? '', 10) || DEFAULT_CONFIG.server.port,
    },
    upstream: env.AGENT_TELEMETRY_UPSTREAM_URL
      ? {
          url: env.AGENT_TELEMETRY_UPSTREAM_URL,
          token: env.AGENT_TELEMETRY_UPSTREAM_TOKEN,
        }
      : undefined,
    langfuse:
      env.AGENT_TELEMETRY_LANGFUSE_BASE_URL &&
      env.AGENT_TELEMETRY_LANGFUSE_PUBLIC_KEY &&
      env.AGENT_TELEMETRY_LANGFUSE_SECRET_KEY
        ? {
            baseUrl: env.AGENT_TELEMETRY_LANGFUSE_BASE_URL,
            publicKey: env.AGENT_TELEMETRY_LANGFUSE_PUBLIC_KEY,
            secretKey: env.AGENT_TELEMETRY_LANGFUSE_SECRET_KEY,
          }
        : undefined,
    intervals: {
      logEvents: Number.parseInt(env.AGENT_TELEMETRY_LOG_INTERVAL ?? '', 10) || DEFAULT_CONFIG.intervals.logEvents,
      metrics:
        Number.parseInt(env.AGENT_TELEMETRY_METRICS_INTERVAL ?? '', 10) || DEFAULT_CONFIG.intervals.metrics,
    },
    logLevel: (env.AGENT_TELEMETRY_LOG_LEVEL as TelemetryConfig['logLevel']) ?? DEFAULT_CONFIG.logLevel,
  };

  return { ...config, ...overrides };
}
