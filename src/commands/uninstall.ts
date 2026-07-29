/**
 * Uninstall command — removes agent-telemetry service and cleans OTLP config.
 *
 * Steps:
 *   1. Stop the background service
 *   2. Remove the service file (plist/systemd)
 *   3. Remove OTLP env vars from Claude Code's ~/.claude/settings.json
 *   4. Remove OTLP config from Codex's ~/.codex/config.toml
 *   5. Remove OTLP env vars from shell profile for OpenCode
 *   6. Optionally remove data directory (--purge)
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import {
  detectPlatform,
  getServicePaths,
  stopService,
  removeServiceFile,
} from '../utils/platform.js';
import { removeAllOtlp } from '../utils/otlp-inject.js';

// ANSI color codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
};

interface UninstallOptions {
  /** Also remove the data directory (~/.agent-telemetry) */
  purge?: boolean;
}

export async function uninstallCommand(opts: UninstallOptions = {}): Promise<void> {
  const platform = detectPlatform();
  const paths = getServicePaths();

  console.log(`${C.bold}${C.red}╭─────────────────────────────────────────────╮${C.reset}`);
  console.log(`${C.bold}${C.red}│  agent-telemetry uninstaller                 │${C.reset}`);
  console.log(`${C.bold}${C.red}╰─────────────────────────────────────────────╯${C.reset}`);
  console.log();

  // ─── Step 1: Stop the service ────────────────────────────────────────────
  console.log(`${C.dim}① Stopping service…${C.reset}`);
  try {
    const result = stopService();
    if (result.stopped) {
      console.log(`  ${C.green}✓${C.reset} ${result.message}`);
    } else {
      console.log(`  ${C.yellow}⚠${C.reset} ${result.message}`);
    }
  } catch (err) {
    console.log(`  ${C.yellow}⚠${C.reset} ${err instanceof Error ? err.message : String(err)}`);
  }

  // ─── Step 2: Remove service file ─────────────────────────────────────────
  console.log(`${C.dim}② Removing ${platform} service file…${C.reset}`);
  try {
    const removed = removeServiceFile();
    if (removed) {
      console.log(`  ${C.green}✓${C.reset} Removed ${paths.serviceFile}`);
    } else {
      console.log(`  ${C.dim}→ No service file found${C.reset}`);
    }
  } catch (err) {
    console.log(`  ${C.red}✗${C.reset} ${err instanceof Error ? err.message : String(err)}`);
  }

  // ─── Step 3: Remove OTLP from Claude Code ────────────────────────────────
  console.log(`${C.dim}③ Removing OTLP config from Claude Code…${C.reset}`);
  const results = removeAllOtlp();
  if (results.claudeCodeRemoved > 0) {
    console.log(`  ${C.green}✓${C.reset} Removed ${results.claudeCodeRemoved} env vars from ~/.claude/settings.json`);
  } else {
    console.log(`  ${C.dim}→ No agent-telemetry env vars found${C.reset}`);
  }

  // ─── Step 4: Remove OTLP from Codex ──────────────────────────────────────
  console.log(`${C.dim}④ Removing OTLP config from Codex…${C.reset}`);
  if (results.codexRemoved) {
    console.log(`  ${C.green}✓${C.reset} Removed [otel] sections from ~/.codex/config.toml`);
  } else {
    console.log(`  ${C.dim}→ No agent-telemetry [otel] sections found${C.reset}`);
  }

  // ─── Step 5: Remove OpenCode env vars ──────────────────────────────────────
  console.log(`${C.dim}⑤ Removing OpenCode OTLP env vars…${C.reset}`);
  if (results.opencodeRemoved) {
    console.log(`  ${C.green}✓${C.reset} Removed OTLP env vars from shell profile`);
  } else {
    console.log(`  ${C.dim}→ No agent-telemetry env vars found${C.reset}`);
  }

  // ─── Step 6: Optionally purge data ───────────────────────────────────────
  if (opts.purge) {
    console.log(`${C.dim}⑥ Purging data directory…${C.reset}`);
    if (existsSync(paths.dataDir)) {
      rmSync(paths.dataDir, { recursive: true, force: true });
      console.log(`  ${C.green}✓${C.reset} Removed ${paths.dataDir}`);
    } else {
      console.log(`  ${C.dim}→ Data directory not found${C.reset}`);
    }
  } else {
    console.log(`${C.dim}⑥ Data directory preserved (${paths.dataDir})${C.reset}`);
    console.log(`  ${C.dim}  Use --purge to remove all data${C.reset}`);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log();
  console.log(`${C.bold}${C.green}✓ Uninstall complete!${C.reset}`);
  console.log();
  console.log(`${C.bold}Note:${C.reset}`);
  console.log(`  ${C.dim}•${C.reset} Restart Claude Code / Codex / OpenCode for env changes to take effect`);
  if (!opts.purge) {
    console.log(`  ${C.dim}•${C.reset} Data directory kept. Run ${C.bold}agent-telemetry uninstall --purge${C.reset} to remove it.`);
  }
  console.log();
}