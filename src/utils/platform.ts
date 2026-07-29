/**
 * Platform detection and service file management.
 *
 * Handles creating/removing launchd (macOS) and systemd (Linux) service files
 * for running agent-telemetry as a background service.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Platform = 'macos' | 'linux' | 'other';

export interface ServicePaths {
  /** Path to the agent-telemetry binary */
  binaryPath: string;
  /** Data directory (~/.agent-telemetry) */
  dataDir: string;
  /** Log directory */
  logDir: string;
  /** Path to the service file (plist or .service) */
  serviceFile: string;
  /** Service label/name */
  serviceName: string;
}

// ─── Platform detection ──────────────────────────────────────────────────────

export function detectPlatform(): Platform {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'other';
}

/**
 * Find the agent-telemetry binary.
 * Priority: symlink in install dir → PATH lookup → current process.
 */
export function findBinary(): string {
  // 1. Check common install locations
  const home = process.env.HOME ?? '~';
  const candidates = [
    '/usr/local/bin/agent-telemetry',
    join(home, '.local', 'bin', 'agent-telemetry'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 2. Check if running via bun (development)
  // When running via `bun run src/cli.ts`, process.argv[1] is the script path
  // and we should suggest building the binary
  return '';
}

/**
 * Get the binary path to use for the service.
 * If a compiled binary exists, use it. Otherwise, fall back to `bun run`.
 */
export function getBinaryCommand(): { program: string; args: string[] } {
  const home = process.env.HOME ?? '~';
  const localBin = join(home, '.local', 'bin', 'agent-telemetry');
  const globalBin = '/usr/local/bin/agent-telemetry';

  if (existsSync(localBin) && statSync(localBin).mode & 0o111) {
    return { program: localBin, args: [] };
  }
  if (existsSync(globalBin) && statSync(globalBin).mode & 0o111) {
    return { program: globalBin, args: [] };
  }

  // Fall back to bun running the source.
  // Use process.execPath (absolute path to the running bun binary) so that
  // launchd/systemd — which don't inherit the shell PATH — can find it.
  const scriptPath = findScriptPath();
  if (scriptPath) {
    return { program: process.execPath, args: ['run', scriptPath] };
  }

  return { program: 'agent-telemetry', args: [] };
}

/**
 * Find the src/cli.ts path relative to this module.
 * Avoids import.meta (not compatible with all TS module modes).
 */
function findScriptPath(): string | null {
  // Fallback: check relative to cwd (common when running from project root via `bun run src/cli.ts`)
  const cwdCli = join(process.cwd(), 'src', 'cli.ts');
  if (existsSync(cwdCli)) return cwdCli;

  // Check relative to the binary location's likely project root
  // When compiled, __dirname isn't available, but we can check a few common spots
  const home = process.env.HOME ?? '~';
  const projectCli = join(home, 'code', 'agent-telemetry', 'src', 'cli.ts');
  if (existsSync(projectCli)) return projectCli;

  return null;
}

// ─── Path resolution ─────────────────────────────────────────────────────────

export function getServicePaths(): ServicePaths {
  const home = process.env.HOME ?? '~';
  const platform = detectPlatform();
  const dataDir = join(home, '.agent-telemetry');
  const logDir = join(dataDir, 'logs');

  const cmd = getBinaryCommand();
  // For the service file, we store the full command
  // (binary path or bun command)

  if (platform === 'macos') {
    return {
      binaryPath: cmd.program,
      dataDir,
      logDir,
      serviceFile: join(home, 'Library', 'LaunchAgents', 'com.agent-telemetry.plist'),
      serviceName: 'com.agent-telemetry',
    };
  }

  // Linux / other → systemd user service
  return {
    binaryPath: cmd.program,
    dataDir,
    logDir,
    serviceFile: join(home, '.config', 'systemd', 'user', 'agent-telemetry.service'),
    serviceName: 'agent-telemetry',
  };
}

// ─── Service file creation ───────────────────────────────────────────────────

/**
 * Generate the macOS launchd plist content.
 */
function generatePlist(paths: ServicePaths, cmd: { program: string; args: string[] }): string {
  const programArgs = `<string>${escapeXml(cmd.program)}</string>${cmd.args.map((a) => `\n        <string>${escapeXml(a)}</string>`).join('')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${paths.serviceName}</string>
    <key>ProgramArguments</key>
    <array>
        ${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${paths.logDir}/agent-telemetry.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${paths.logDir}/agent-telemetry.stderr.log</string>
    <key>WorkingDirectory</key>
    <string>${paths.dataDir}</string>
</dict>
</plist>
`;
}

/**
 * Generate the Linux systemd user service content.
 */
function generateSystemdService(paths: ServicePaths, cmd: { program: string; args: string[] }): string {
  const execStart = `${cmd.program} ${cmd.args.map(escapeShell).join(' ')}`.trim();
  return `[Unit]
Description=Agent Telemetry - OTLP collector for AI coding agents
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${paths.dataDir}
Restart=on-failure
RestartSec=5
StandardOutput=append:${paths.logDir}/agent-telemetry.stdout.log
StandardError=append:${paths.logDir}/agent-telemetry.stderr.log

[Install]
WantedBy=default.target
`;
}

/**
 * Create the service file (launchd plist or systemd service).
 * Creates parent directories as needed.
 * Idempotent: overwrites if already exists.
 */
export function createServiceFile(): { path: string; created: boolean } {
  const paths = getServicePaths();
  const cmd = getBinaryCommand();
  const platform = detectPlatform();

  // Ensure directories exist
  const serviceDir = join(paths.serviceFile, '..');
  if (!existsSync(serviceDir)) {
    mkdirSync(serviceDir, { recursive: true });
  }
  if (!existsSync(paths.logDir)) {
    mkdirSync(paths.logDir, { recursive: true });
  }
  if (!existsSync(paths.dataDir)) {
    mkdirSync(paths.dataDir, { recursive: true });
  }

  const content = platform === 'macos' ? generatePlist(paths, cmd) : generateSystemdService(paths, cmd);
  const existed = existsSync(paths.serviceFile);
  writeFileSync(paths.serviceFile, content);
  logger.info('Service file created', { path: paths.serviceFile, platform });

  return { path: paths.serviceFile, created: !existed };
}

/**
 * Remove the service file if it exists.
 */
export function removeServiceFile(): boolean {
  const paths = getServicePaths();
  if (!existsSync(paths.serviceFile)) return false;
  unlinkSync(paths.serviceFile);
  logger.info('Service file removed', { path: paths.serviceFile });
  return true;
}

// ─── Service control ─────────────────────────────────────────────────────────

/**
 * Start the background service.
 * macOS: launchctl bootstrap / kickstart
 * Linux: systemctl --user enable --now
 */
export function startService(): { started: boolean; message: string } {
  const platform = detectPlatform();
  const paths = getServicePaths();

  if (platform === 'macos') {
    return startLaunchdService(paths);
  }
  if (platform === 'linux') {
    return startSystemdService(paths);
  }
  return { started: false, message: `Unsupported platform: ${platform}` };
}

function startLaunchdService(paths: ServicePaths): { started: boolean; message: string } {
  const uid = process.getuid?.() ?? 501;
  // Try kickstart first (works if already bootstrapped)
  const kickstartResult = Bun.spawnSync({
    cmd: ['launchctl', 'kickstart', `-k`, `gui/${uid}/${paths.serviceName}`],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (kickstartResult.exitCode === 0) {
    return { started: true, message: 'Service started (kickstart)' };
  }

  // Fall back to bootstrap
  const bootstrapResult = Bun.spawnSync({
    cmd: ['launchctl', 'bootstrap', `gui/${uid}`, paths.serviceFile],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (bootstrapResult.exitCode === 0) {
    return { started: true, message: 'Service started (bootstrap)' };
  }

  const stderr = new TextDecoder().decode(bootstrapResult.stderr).trim();
  // "already bootstrapped" is not really an error
  if (stderr.includes('already bootstrapped') || stderr.includes('Bootstrap failed: 5')) {
    // Try kickstart without -k
    const ks2 = Bun.spawnSync({
      cmd: ['launchctl', 'kickstart', `gui/${uid}/${paths.serviceName}`],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (ks2.exitCode === 0) {
      return { started: true, message: 'Service started (kickstart after bootstrap)' };
    }
  }

  return {
    started: false,
    message: `Failed to start service: ${stderr || 'unknown error'}`,
  };
}

function startSystemdService(_paths: ServicePaths): { started: boolean; message: string } {
  const reloadResult = Bun.spawnSync({
    cmd: ['systemctl', '--user', 'daemon-reload'],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const enableResult = Bun.spawnSync({
    cmd: ['systemctl', '--user', 'enable', '--now', 'agent-telemetry'],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (enableResult.exitCode === 0) {
    return { started: true, message: 'Service started (systemctl enable --now)' };
  }

  const stderr = new TextDecoder().decode(enableResult.stderr).trim();
  const reloadErr = new TextDecoder().decode(reloadResult.stderr).trim();
  return {
    started: false,
    message: `Failed to start service: ${stderr || reloadErr || 'unknown error'}`,
  };
}

/**
 * Stop the background service.
 */
export function stopService(): { stopped: boolean; message: string } {
  const platform = detectPlatform();
  const paths = getServicePaths();

  if (platform === 'macos') {
    return stopLaunchdService(paths);
  }
  if (platform === 'linux') {
    return stopSystemdService(paths);
  }
  return { stopped: false, message: `Unsupported platform: ${platform}` };
}

function stopLaunchdService(paths: ServicePaths): { stopped: boolean; message: string } {
  const uid = process.getuid?.() ?? 501;

  const bootoutResult = Bun.spawnSync({
    cmd: ['launchctl', 'bootout', `gui/${uid}/${paths.serviceName}`],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (bootoutResult.exitCode === 0) {
    return { stopped: true, message: 'Service stopped (bootout)' };
  }

  const stderr = new TextDecoder().decode(bootoutResult.stderr).trim();
  if (stderr.includes('not bootstrapped') || stderr.includes('No such process')) {
    return { stopped: true, message: 'Service was not running' };
  }

  return {
    stopped: false,
    message: `Failed to stop service: ${stderr || 'unknown error'}`,
  };
}

function stopSystemdService(_paths: ServicePaths): { stopped: boolean; message: string } {
  const result = Bun.spawnSync({
    cmd: ['systemctl', '--user', 'stop', 'agent-telemetry'],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode === 0) {
    return { stopped: true, message: 'Service stopped (systemctl stop)' };
  }

  const stderr = new TextDecoder().decode(result.stderr).trim();
  return {
    stopped: false,
    message: `Failed to stop service: ${stderr || 'unknown error'}`,
  };
}

/**
 * Check if the service is currently running.
 */
export function isServiceRunning(): boolean {
  const platform = detectPlatform();
  const paths = getServicePaths();

  if (platform === 'macos') {
    const uid = process.getuid?.() ?? 501;
    const result = Bun.spawnSync({
      cmd: ['launchctl', 'print', `gui/${uid}/${paths.serviceName}`],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return result.exitCode === 0;
  }

  if (platform === 'linux') {
    const result = Bun.spawnSync({
      cmd: ['systemctl', '--user', 'is-active', 'agent-telemetry'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new TextDecoder().decode(result.stdout).trim();
    return stdout === 'active';
  }

  return false;
}

// ─── Escaping helpers ────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeShell(s: string): string {
  if (/^[a-zA-Z0-9_\-\/.]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
