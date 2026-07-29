/**
 * Logs command — tails the agent-telemetry log files.
 *
 * Uses `tail -f` on the stdout/stderr log files in the data directory.
 * If the logs don't exist yet, prints a helpful message.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getServicePaths } from '../utils/platform.js';

// ANSI color codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
};

interface LogsOptions {
  /** Number of lines to show before tailing (default: 50) */
  lines?: number;
  /** Which log to tail: stdout, stderr, or both (default: both) */
  which?: 'stdout' | 'stderr' | 'both';
}

export async function logsCommand(opts: LogsOptions = {}): Promise<void> {
  const paths = getServicePaths();
  const lines = opts.lines ?? 50;
  const which = opts.which ?? 'both';

  const stdoutLog = join(paths.logDir, 'agent-telemetry.stdout.log');
  const stderrLog = join(paths.logDir, 'agent-telemetry.stderr.log');

  const stdoutExists = existsSync(stdoutLog);
  const stderrExists = existsSync(stderrLog);

  if (!stdoutExists && !stderrExists) {
    console.log(`${C.yellow}⚠${C.reset} No log files found at ${paths.logDir}`);
    console.log();
    console.log(`${C.dim}The service may not be running or hasn't produced output yet.${C.reset}`);
    console.log(`${C.dim}Try starting it:${C.reset}`);
    console.log(`  ${C.bold}agent-telemetry install${C.reset}`);
    console.log();
    return;
  }

  const files: string[] = [];
  if ((which === 'stdout' || which === 'both') && stdoutExists) files.push(stdoutLog);
  if ((which === 'stderr' || which === 'both') && stderrExists) files.push(stderrLog);

  if (files.length === 0) {
    console.log(`${C.yellow}⚠${C.reset} Requested log file(s) not found.`);
    console.log(`${C.dim}Available:${C.reset}`);
    if (stdoutExists) console.log(`  stdout: ${stdoutLog}`);
    if (stderrExists) console.log(`  stderr: ${stderrLog}`);
    return;
  }

  console.log(`${C.dim}Tailing ${files.length} log file(s)… (Ctrl+C to stop)${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(50)}${C.reset}`);
  for (const f of files) {
    console.log(`${C.dim}  ${f}${C.reset}`);
  }
  console.log(`${C.dim}${'─'.repeat(50)}${C.reset}`);
  console.log();

  // Use tail -f to follow the logs
  // If multiple files, use tail -f with all of them
  const args = ['-n', String(lines), '-f', ...files];
  const proc = Bun.spawn({
    cmd: ['tail', ...args],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  // Wait for the process (it runs until Ctrl+C)
  const exitCode = await proc.exited;
  if (exitCode !== 0 && exitCode !== 130) {
    // 130 = SIGINT (Ctrl+C), which is normal
    console.log(`${C.yellow}⚠${C.reset} tail exited with code ${exitCode}`);
  }
}