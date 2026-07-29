/**
 * Agent Telemetry — Configuration
 *
 * Configuration is loaded from a YAML file (config.yml). The file path can be
 * overridden with the AGENT_TELEMETRY_CONFIG env var. By default, the loader
 * looks for `config.yml` in the data directory (`~/.agent-telemetry/config.yml`).
 * If no config file is found, sensible defaults are used (collect everything,
 * no forwarding, no upstream).
 *
 * Supported YAML structure:
 *   data_dir, server, collect_logs, collect_metrics, collect_traces,
 *   agents (per-agent filters), upstream, otlp_forwarders, log_level
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from './utils/logger.js';

// ─── Config types ───────────────────────────────────────────────────────────

export interface AgentFilter {
  /** allow = whitelist, deny = blacklist, all = collect everything */
  mode: 'allow' | 'deny' | 'all';
  list: string[];
}

export interface AgentConfig {
  log_events?: AgentFilter;
  metrics?: AgentFilter;
  traces?: AgentFilter;
}

export interface AuthConfig {
  type: 'basic' | 'bearer' | 'header' | 'none';
  username?: string; // for basic
  password?: string; // for basic
  token?: string; // for bearer
  headers?: Record<string, string>; // for header type
}

export interface OtlpForwarder {
  name: string;
  url: string;
  auth: AuthConfig;
  signals: ('traces' | 'logs' | 'metrics')[];
  enabled: boolean;
}

export interface UpstreamConfig {
  url: string;
  token?: string;
  batch_size: number;
  interval_ms: number;
  report_logs: boolean;
  report_metrics: boolean;
}

export interface TelemetryConfig {
  data_dir: string;
  server: { host: string; port: number };
  collect_logs: boolean;
  collect_metrics: boolean;
  collect_traces: boolean;
  agents: Record<string, AgentConfig>;
  upstream: UpstreamConfig;
  otlp_forwarders: OtlpForwarder[];
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_DATA_DIR = `${process.env.HOME ?? '~'}/.agent-telemetry`;

const DEFAULT_CONFIG: TelemetryConfig = {
  data_dir: DEFAULT_DATA_DIR,
  server: {
    host: '127.0.0.1',
    port: 9911,
  },
  collect_logs: true,
  collect_metrics: true,
  collect_traces: true,
  agents: {},
  upstream: {
    url: '',
    batch_size: 500,
    interval_ms: 600_000, // 10 minutes
    report_logs: true,
    report_metrics: true,
  },
  otlp_forwarders: [],
  log_level: 'info',
};

// ─── Config file resolution ─────────────────────────────────────────────────

/**
 * Resolve the config file path.
 * Priority: AGENT_TELEMETRY_CONFIG env var → config.yml in data dir.
 */
function resolveConfigPath(dataDir: string): string | null {
  const envPath = process.env.AGENT_TELEMETRY_CONFIG;
  if (envPath) return envPath;

  const defaultPath = join(dataDir, 'config.yml');
  if (existsSync(defaultPath)) return defaultPath;

  return null;
}

/**
 * Deep-merge a partial YAML config on top of the default config.
 * Only known keys are copied; unknown keys are ignored.
 */
function mergeConfig(raw: Record<string, unknown>): TelemetryConfig {
  const serverRaw = raw.server;
  const serverObj = serverRaw && typeof serverRaw === 'object' ? (serverRaw as Record<string, unknown>) : {};
  const config: TelemetryConfig = {
    data_dir: typeof raw.data_dir === 'string' ? expandTilde(raw.data_dir) : DEFAULT_CONFIG.data_dir,
    server: {
      host: typeof serverObj.host === 'string' ? serverObj.host : DEFAULT_CONFIG.server.host,
      port: typeof serverObj.port === 'number' ? serverObj.port : DEFAULT_CONFIG.server.port,
    },
    collect_logs: typeof raw.collect_logs === 'boolean' ? raw.collect_logs : DEFAULT_CONFIG.collect_logs,
    collect_metrics: typeof raw.collect_metrics === 'boolean' ? raw.collect_metrics : DEFAULT_CONFIG.collect_metrics,
    collect_traces: typeof raw.collect_traces === 'boolean' ? raw.collect_traces : DEFAULT_CONFIG.collect_traces,
    agents: parseAgents(raw.agents),
    upstream: parseUpstream(raw.upstream),
    otlp_forwarders: parseForwarders(raw.otlp_forwarders),
    log_level: parseLogLevel(raw.log_level),
  };

  // Env var overrides (take precedence over file for key operational settings)
  const env = process.env;
  if (env.AGENT_TELEMETRY_HOST) config.server.host = env.AGENT_TELEMETRY_HOST;
  if (env.AGENT_TELEMETRY_PORT) {
    const port = Number.parseInt(env.AGENT_TELEMETRY_PORT, 10);
    if (!Number.isNaN(port)) config.server.port = port;
  }
  if (env.AGENT_TELEMETRY_DATA_DIR) config.data_dir = expandTilde(env.AGENT_TELEMETRY_DATA_DIR);
  if (env.AGENT_TELEMETRY_LOG_LEVEL) {
    config.log_level = parseLogLevel(env.AGENT_TELEMETRY_LOG_LEVEL);
  }
  if (env.AGENT_TELEMETRY_UPSTREAM_URL) {
    config.upstream.url = env.AGENT_TELEMETRY_UPSTREAM_URL;
  }
  if (env.AGENT_TELEMETRY_UPSTREAM_TOKEN) {
    config.upstream.token = env.AGENT_TELEMETRY_UPSTREAM_TOKEN;
  }

  return config;
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace(/^~/, process.env.HOME ?? '~');
  }
  return p;
}

function parseAgents(raw: unknown): Record<string, AgentConfig> {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG.agents;
  const obj = raw as Record<string, unknown>;
  const result: Record<string, AgentConfig> = {};
  for (const [agentKey, agentRaw] of Object.entries(obj)) {
    if (!agentRaw || typeof agentRaw !== 'object') continue;
    const agentObj = agentRaw as Record<string, unknown>;
    const agentCfg: AgentConfig = {};
    for (const signal of ['log_events', 'metrics', 'traces'] as const) {
      const filterRaw = agentObj[signal];
      if (filterRaw && typeof filterRaw === 'object') {
        const f = filterRaw as Record<string, unknown>;
        agentCfg[signal] = {
          mode: f.mode === 'allow' || f.mode === 'deny' ? f.mode : 'all',
          list: Array.isArray(f.list) ? f.list.filter((x) => typeof x === 'string') : [],
        };
      }
    }
    result[agentKey] = agentCfg;
  }
  return result;
}

function parseUpstream(raw: unknown): UpstreamConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG.upstream };
  const u = raw as Record<string, unknown>;
  return {
    url: typeof u.url === 'string' ? u.url : '',
    token: typeof u.token === 'string' && u.token ? u.token : undefined,
    batch_size: typeof u.batch_size === 'number' ? u.batch_size : DEFAULT_CONFIG.upstream.batch_size,
    interval_ms: typeof u.interval_ms === 'number' ? u.interval_ms : DEFAULT_CONFIG.upstream.interval_ms,
    report_logs: typeof u.report_logs === 'boolean' ? u.report_logs : true,
    report_metrics: typeof u.report_metrics === 'boolean' ? u.report_metrics : true,
  };
}

function parseForwarders(raw: unknown): OtlpForwarder[] {
  if (!Array.isArray(raw)) return [];
  const result: OtlpForwarder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    if (typeof f.url !== 'string' || !f.url) continue;
    result.push({
      name: typeof f.name === 'string' ? f.name : f.url,
      url: f.url,
      auth: parseAuth(f.auth),
      signals: parseSignals(f.signals),
      enabled: typeof f.enabled === 'boolean' ? f.enabled : true,
    });
  }
  return result;
}

function parseAuth(raw: unknown): AuthConfig {
  if (!raw || typeof raw !== 'object') return { type: 'none' };
  const a = raw as Record<string, unknown>;
  const type = a.type === 'basic' || a.type === 'bearer' || a.type === 'header' ? a.type : 'none';
  const auth: AuthConfig = { type };
  if (type === 'basic') {
    if (typeof a.username === 'string') auth.username = a.username;
    if (typeof a.password === 'string') auth.password = a.password;
  } else if (type === 'bearer') {
    if (typeof a.token === 'string') auth.token = a.token;
  } else if (type === 'header') {
    if (a.headers && typeof a.headers === 'object') {
      auth.headers = a.headers as Record<string, string>;
    }
  }
  return auth;
}

function parseSignals(raw: unknown): ('traces' | 'logs' | 'metrics')[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(['traces', 'logs', 'metrics']);
  return raw.filter((s): s is 'traces' | 'logs' | 'metrics' => typeof s === 'string' && valid.has(s));
}

function parseLogLevel(raw: unknown): TelemetryConfig['log_level'] {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load config from YAML file (and env var overrides).
 * If no config file exists, returns defaults (collect everything, no forwarding).
 */
export function loadConfig(overrides?: Partial<TelemetryConfig>): TelemetryConfig {
  // First determine data_dir from env or default (needed to locate config.yml)
  const initialDataDir = process.env.AGENT_TELEMETRY_DATA_DIR
    ? expandTilde(process.env.AGENT_TELEMETRY_DATA_DIR)
    : DEFAULT_DATA_DIR;

  const configPath = resolveConfigPath(initialDataDir);

  if (!configPath) {
    logger.info('No config file found, using defaults', { dataDir: initialDataDir });
    const config = mergeConfig({});
    return { ...config, ...(overrides ?? {}) };
  }

  try {
    const absPath = resolve(configPath);
    const fileContent = readFileSync(absPath, 'utf-8');
    const raw = parseYaml(fileContent) as Record<string, unknown>;
    logger.info('Loaded config from file', { path: absPath });
    const config = mergeConfig(raw ?? {});
    return { ...config, ...(overrides ?? {}) };
  } catch (err) {
    logger.warn('Failed to load config file, using defaults: {message}', {
      path: configPath,
      message: err instanceof Error ? err.message : String(err),
    });
    const config = mergeConfig({});
    return { ...config, ...(overrides ?? {}) };
  }
}
