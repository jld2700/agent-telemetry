/**
 * Install command — installs agent-telemetry as a background service
 * and injects OTLP config into Claude Code, Codex, and OpenCode.
 *
 * Steps:
 *   1. Create data directory (~/.agent-telemetry)
 *   2. Copy config.yml template (if not already present)
 *   3. Create launchd (macOS) or systemd (Linux) service file
 *   4. Start the service
 *   5. Inject OTLP env vars into Claude Code's ~/.claude/settings.json
 *   6. Inject OTLP config into Codex's ~/.codex/config.toml (if installed)
 *   7. Inject OTLP env vars into shell profile for OpenCode (if installed)
 *   8. Print next steps
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import {
	DEFAULT_OTLP_ENDPOINT,
	ensureConfigFile,
	injectAllOtlp,
} from "../utils/otlp-inject.js";
import {
	createServiceFile,
	detectPlatform,
	getBinaryCommand,
	getServicePaths,
	startService,
} from "../utils/platform.js";

// ANSI color codes for CLI output
const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	red: "\x1b[31m",
	dim: "\x1b[2m",
};

interface InstallOptions {
	/** OTLP endpoint to inject (default: http://127.0.0.1:9911/api/otel) */
	endpoint?: string;
	/** Skip OTLP injection into Claude Code / Codex */
	skipOtlp?: boolean;
	/** Skip service installation (only inject OTLP) */
	skipService?: boolean;
}

export async function installCommand(opts: InstallOptions = {}): Promise<void> {
	const endpoint = opts.endpoint ?? DEFAULT_OTLP_ENDPOINT;
	const platform = detectPlatform();
	const paths = getServicePaths();

	console.log(
		`${C.bold}${C.blue}╭─────────────────────────────────────────────╮${C.reset}`,
	);
	console.log(
		`${C.bold}${C.blue}│  agent-telemetry installer                   │${C.reset}`,
	);
	console.log(
		`${C.bold}${C.blue}╰─────────────────────────────────────────────╯${C.reset}`,
	);
	console.log();

	// ─── Step 1: Create data directory ──────────────────────────────────────
	console.log(`${C.dim}① Creating data directory…${C.reset}`);
	if (!existsSync(paths.dataDir)) {
		mkdirSync(paths.dataDir, { recursive: true });
		console.log(`  ${C.green}✓${C.reset} Created ${paths.dataDir}`);
	} else {
		console.log(`  ${C.dim}→ Already exists: ${paths.dataDir}${C.reset}`);
	}

	// ─── Step 2: Copy config template ───────────────────────────────────────
	console.log(`${C.dim}② Setting up config…${C.reset}`);
	const sourceConfig = join(process.cwd(), "config.yml");
	const copied = ensureConfigFile(sourceConfig);
	if (copied) {
		console.log(
			`  ${C.green}✓${C.reset} Copied config.yml → ${join(paths.dataDir, "config.yml")}`,
		);
	} else if (existsSync(join(paths.dataDir, "config.yml"))) {
		console.log(
			`  ${C.dim}→ Config already exists: ${join(paths.dataDir, "config.yml")}${C.reset}`,
		);
	} else {
		console.log(
			`  ${C.yellow}⚠${C.reset} No config template found, using defaults`,
		);
	}

	// ─── Step 3: Create service file ────────────────────────────────────────
	if (!opts.skipService) {
		console.log(`${C.dim}③ Creating ${platform} service…${C.reset}`);
		const cmd = getBinaryCommand();
		console.log(
			`  ${C.dim}Command: ${cmd.program} ${cmd.args.join(" ")}${C.reset}`,
		);

		try {
			const result = createServiceFile();
			console.log(`  ${C.green}✓${C.reset} Service file: ${result.path}`);
		} catch (err) {
			console.log(
				`  ${C.red}✗${C.reset} Failed to create service file: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// ─── Step 4: Start the service ──────────────────────────────────────
		console.log(`${C.dim}④ Starting service…${C.reset}`);
		try {
			const result = startService();
			if (result.started) {
				console.log(`  ${C.green}✓${C.reset} ${result.message}`);
			} else {
				console.log(`  ${C.yellow}⚠${C.reset} ${result.message}`);
				console.log(`  ${C.dim}  You can start it manually later.${C.reset}`);
			}
		} catch (err) {
			console.log(
				`  ${C.yellow}⚠${C.reset} Could not start service: ${err instanceof Error ? err.message : String(err)}`,
			);
			console.log(`  ${C.dim}  You can start it manually later.${C.reset}`);
		}
	} else {
		console.log(
			`${C.dim}③④ Skipping service installation (--skip-service)${C.reset}`,
		);
	}

	// ─── Step 5 & 6: Inject OTLP config ─────────────────────────────────────
	if (!opts.skipOtlp) {
		console.log(`${C.dim}⑤ Injecting OTLP config into Claude Code…${C.reset}`);
		const results = injectAllOtlp(endpoint);

		if (results.claudeCode.changed) {
			const allKeys = [
				...results.claudeCode.keysAdded,
				...results.claudeCode.keysUpdated,
			];
			console.log(`  ${C.green}✓${C.reset} Updated ${results.claudeCode.path}`);
			console.log(`  ${C.dim}  Keys: ${allKeys.join(", ")}${C.reset}`);
		} else {
			console.log(
				`  ${C.dim}→ Already up to date: ${results.claudeCode.path}${C.reset}`,
			);
		}

		if (results.codex) {
			console.log(`${C.dim}⑥ Injecting OTLP config into Codex…${C.reset}`);
			if (results.codex.changed) {
				console.log(`  ${C.green}✓${C.reset} Updated ${results.codex.path}`);
			} else {
				console.log(
					`  ${C.dim}→ Already up to date: ${results.codex.path}${C.reset}`,
				);
			}
		} else {
			console.log(`${C.dim}⑥ Codex not detected, skipping${C.reset}`);
		}

		if (results.opencode) {
			console.log(`${C.dim}⑦ Injecting OTLP env vars for OpenCode…${C.reset}`);
			if (results.opencode.changed) {
				console.log(`  ${C.green}✓${C.reset} Updated ${results.opencode.path}`);
			} else {
				console.log(
					`  ${C.dim}→ Already up to date: ${results.opencode.path}${C.reset}`,
				);
			}
		} else {
			console.log(`${C.dim}⑦ OpenCode not detected, skipping${C.reset}`);
		}
	} else {
		console.log(`${C.dim}⑤⑥⑦ Skipping OTLP injection (--skip-otlp)${C.reset}`);
	}

	// ─── Summary & next steps ────────────────────────────────────────────────
	console.log();
	console.log(`${C.bold}${C.green}✓ Installation complete!${C.reset}`);
	console.log();
	console.log(`${C.bold}Next steps:${C.reset}`);
	console.log(
		`  ${C.dim}•${C.reset} Check status:    ${C.bold}agent-telemetry status${C.reset}`,
	);
	console.log(
		`  ${C.dim}•${C.reset} View logs:       ${C.bold}agent-telemetry logs${C.reset}`,
	);
	console.log(
		`  ${C.dim}•${C.reset} Edit config:     ${C.bold}agent-telemetry config${C.reset}`,
	);
	console.log(
		`  ${C.dim}•${C.reset} Restart Claude Code for OTLP env vars to take effect`,
	);
	console.log();
	console.log(`${C.bold}How to verify it's working:${C.reset}`);
	console.log(`  ${C.dim}•${C.reset} Run any Claude Code session, then check:`);
	console.log(
		`    ${C.bold}agent-telemetry status${C.reset} ${C.dim}(should show event count > 0)${C.reset}`,
	);
	console.log();
	console.log(`${C.bold}To uninstall:${C.reset}`);
	console.log(`  ${C.bold}agent-telemetry uninstall${C.reset}`);
	console.log();
}

export { DEFAULT_OTLP_ENDPOINT };
