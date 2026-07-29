/**
 * Status command — shows whether agent-telemetry is running and DB stats.
 *
 * Displays:
 *   - Service status (running / stopped)
 *   - Server port and reachability
 *   - Database file size
 *   - Event counts (log_events, otel_metrics)
 *   - Config file location
 *   - Log file location
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import {
  detectPlatform,
  getServicePaths,
  isServiceRunning,
} from '../utils/platform.js';

// ANSI color codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
};

export async function statusCommand(): Promise<void> {
  const platform = detectPlatform();
  const paths = getServicePaths();
  const dbPath = join(paths.dataDir, 'agent-telemetry.db');
  const configPath = join(paths.dataDir, 'config.yml');

  console.log(`${C.bold}${C.cyan}agent-telemetry status${C.reset}`);
  console.log(`${C.dim}────────────────────────────────────────${C.reset}`);
  console.log();

  // ─── Service status ──────────────────────────────────────────────────────
  const running = isServiceRunning();
  const statusIcon = running ? `${C.green}●${C.reset}` : `${C.red}○${C.reset}`;
  const statusText = running ? `${C.green}running${C.reset}` : `${C.red}stopped${C.reset}`;
  console.log(`${C.bold}Service:${C.reset}    ${statusIcon} ${statusText}  ${C.dim}(${platform})${C.reset}`);

  // ─── Port reachability ───────────────────────────────────────────────────
  const port = 9911; // default port; could read from config
  let portReachable = false;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceLogs: [] }),
      signal: AbortSignal.timeout(2000),
    });
    portReachable = resp.status === 200;
  } catch {
    // Server not reachable
  }
  const portIcon = portReachable ? `${C.green}●${C.reset}` : `${C.red}○${C.reset}`;
  console.log(`${C.bold}Server:${C.reset}     ${portIcon} ${portReachable ? `${C.green}listening${C.reset}` : `${C.red}unreachable${C.reset}`}  ${C.dim}(127.0.0.1:${port})${C.reset}`);

  // ─── Database stats ──────────────────────────────────────────────────────
  console.log();
  console.log(`${C.bold}Database:${C.reset}`);
  if (existsSync(dbPath)) {
    const stat = statSync(dbPath);
    const sizeStr = formatBytes(stat.size);
    console.log(`  ${C.dim}Path:${C.reset}  ${dbPath}`);
    console.log(`  ${C.dim}Size:${C.reset}  ${sizeStr}`);

    // Query event counts (open DB read-only)
    try {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });

      const logCount = (db.query('SELECT COUNT(*) as c FROM log_events').get() as { c: number })?.c ?? 0;
      const metricCount = (db.query('SELECT COUNT(*) as c FROM otel_metrics').get() as { c: number })?.c ?? 0;
      const pendingLogs = (db.query('SELECT COUNT(*) as c FROM log_events WHERE uploaded_at IS NULL').get() as { c: number })?.c ?? 0;
      const pendingMetrics = (db.query('SELECT COUNT(*) as c FROM otel_metrics WHERE uploaded_at IS NULL').get() as { c: number })?.c ?? 0;

      console.log(`  ${C.dim}Events:${C.reset}        ${C.bold}${logCount}${C.reset} log events ${C.dim}(${pendingLogs} pending)${C.reset}`);
      console.log(`  ${C.dim}Metrics:${C.reset}       ${C.bold}${metricCount}${C.reset} metric datapoints ${C.dim}(${pendingMetrics} pending)${C.reset}`);

      // Show recent activity
      const recent = db
        .query('SELECT event_name, created_at FROM log_events ORDER BY id DESC LIMIT 5')
        .all() as Array<{ event_name: string; created_at: string }>;
      if (recent.length > 0) {
        console.log();
        console.log(`  ${C.dim}Recent events:${C.reset}`);
        for (const r of recent) {
          console.log(`    ${C.dim}${r.created_at}${C.reset}  ${r.event_name}`);
        }
      }

      db.close();
    } catch (err) {
      console.log(`  ${C.yellow}⚠${C.reset} Could not read database: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(`  ${C.dim}No database file found${C.reset}`);
    console.log(`  ${C.dim}Path would be: ${dbPath}${C.reset}`);
  }

  // ─── Paths ───────────────────────────────────────────────────────────────
  console.log();
  console.log(`${C.bold}Paths:${C.reset}`);
  console.log(`  ${C.dim}Data dir:${C.reset}    ${paths.dataDir}`);
  console.log(`  ${C.dim}Config:${C.reset}      ${existsSync(configPath) ? configPath : `${configPath} ${C.yellow}(not found, using defaults)${C.reset}`}`);
  console.log(`  ${C.dim}Logs:${C.reset}        ${paths.logDir}/`);
  console.log(`  ${C.dim}Service file:${C.reset} ${existsSync(paths.serviceFile) ? paths.serviceFile : `${paths.serviceFile} ${C.yellow}(not installed)${C.reset}`}`);
  console.log();

  // ─── OTLP injection status ───────────────────────────────────────────────
  console.log(`${C.bold}OTLP Injection:${C.reset}`);
  const claudePath = join(process.env.HOME ?? '~', '.claude', 'settings.json');
  const codexPath = join(process.env.HOME ?? '~', '.codex', 'config.toml');

  if (existsSync(claudePath)) {
    const content = (await import('fs')).readFileSync(claudePath, 'utf-8');
    const hasOtlp = content.includes('OTEL_EXPORTER_OTLP_ENDPOINT');
    console.log(`  ${C.dim}Claude Code:${C.reset}  ${hasOtlp ? `${C.green}✓ injected${C.reset}` : `${C.yellow}⚠ not injected${C.reset}`}  ${C.dim}(${claudePath})${C.reset}`);
  } else {
    console.log(`  ${C.dim}Claude Code:${C.reset}  ${C.yellow}⚠ not found${C.reset}  ${C.dim}(${claudePath})${C.reset}`);
  }

  if (existsSync(codexPath)) {
    const content = (await import('fs')).readFileSync(codexPath, 'utf-8');
    const hasOtel = /^\[otel/m.test(content);
    console.log(`  ${C.dim}Codex:${C.reset}        ${hasOtel ? `${C.green}✓ injected${C.reset}` : `${C.yellow}⚠ not injected${C.reset}`}  ${C.dim}(${codexPath})${C.reset}`);
  } else {
    console.log(`  ${C.dim}Codex:${C.reset}        ${C.dim}not detected${C.reset}`);
  }

  // Check OpenCode injection (shell profile env vars)
  const opencodeDir = join(process.env.HOME ?? '~', '.config', 'opencode');
  if (existsSync(opencodeDir)) {
    const shell = process.env.SHELL ?? '';
    const profilePath = shell.includes('zsh') || process.platform === 'darwin'
      ? join(process.env.HOME ?? '~', '.zshrc')
      : join(process.env.HOME ?? '~', '.bashrc');
    if (existsSync(profilePath)) {
      const content = (await import('fs')).readFileSync(profilePath, 'utf-8');
      const hasOtel = content.includes('agent-telemetry:opencode');
      console.log(`  ${C.dim}OpenCode:${C.reset}     ${hasOtel ? `${C.green}✓ injected${C.reset}` : `${C.yellow}⚠ not injected${C.reset}`}  ${C.dim}(${profilePath})${C.reset}`);
    } else {
      console.log(`  ${C.dim}OpenCode:${C.reset}     ${C.dim}detected, no shell profile${C.reset}`);
    }
  } else {
    console.log(`  ${C.dim}OpenCode:${C.reset}     ${C.dim}not detected${C.reset}`);
  }

  console.log();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}