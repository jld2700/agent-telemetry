#!/usr/bin/env bun
/**
 * Agent Telemetry — CLI Entry
 *
 * Handles subcommands and starts the telemetry server (default behavior).
 *
 * Usage:
 *   agent-telemetry              # Start server (default)
 *   agent-telemetry install      # Install as service + inject OTLP config
 *   agent-telemetry uninstall    # Remove service + clean OTLP config
 *   agent-telemetry status       # Show: running?, port, DB size, event count
 *   agent-telemetry config       # Open config.yml in $EDITOR
 *   agent-telemetry logs         # Tail logs
 *   agent-telemetry --help       # Show help
 *   agent-telemetry --version    # Show version
 */

import { configCommand } from "./commands/config.js";
import { installCommand } from "./commands/install.js";
import { logsCommand } from "./commands/logs.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { startTelemetry } from "./index.js";

// ─── Help text ───────────────────────────────────────────────────────────────

// ANSI color codes
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const HELP = `
${BOLD}agent-telemetry${RESET} — OTLP telemetry collector for AI coding agents

${BOLD}USAGE${RESET}
  agent-telemetry [command] [options]

${BOLD}COMMANDS${RESET}
  (default)           Start the telemetry server (foreground)
  install             Install as background service + inject OTLP config
  uninstall           Remove service + clean OTLP config from Claude Code/Codex/OpenCode
  status              Show service status, DB stats, OTLP injection status
  config              Open config.yml in $EDITOR
  logs                Tail log files (stdout + stderr)
  help, --help        Show this help message
  version, --version  Show version

${BOLD}INSTALL OPTIONS${RESET}
  --endpoint <url>    Custom OTLP endpoint (default: http://127.0.0.1:9911/api/otel)
  --skip-otlp         Skip OTLP injection into Claude Code/Codex/OpenCode
  --skip-service      Skip service file creation (only inject OTLP)

${BOLD}UNINSTALL OPTIONS${RESET}
  --purge             Also remove data directory (~/.agent-telemetry)

${BOLD}LOGS OPTIONS${RESET}
  --lines <n>         Number of initial lines to show (default: 50)
  --stdout            Only tail stdout log
  --stderr            Only tail stderr log

${BOLD}EXAMPLES${RESET}
  agent-telemetry install
  agent-telemetry install --endpoint http://127.0.0.1:4318/api/otel
  agent-telemetry status
  agent-telemetry uninstall --purge
  agent-telemetry logs --stderr --lines 100

${BOLD}ENVIRONMENT${RESET}
  AGENT_TELEMETRY_CONFIG       Path to config.yml
  AGENT_TELEMETRY_HOST         Server host (default: 127.0.0.1)
  AGENT_TELEMETRY_PORT         Server port (default: 9911)
  AGENT_TELEMETRY_DATA_DIR     Data directory (default: ~/.agent-telemetry)
  AGENT_TELEMETRY_LOG_LEVEL    Log level: debug|info|warn|error
`;

// ─── Argv parsing ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
	command: string;
	flags: Record<string, string | boolean>;
} {
	const args = argv.slice(2); // skip node/bun and script path
	if (args.length === 0) return { command: "serve", flags: {} };

	// Handle --help, -h, --version, -v as direct commands (not as serve)
	const first = args[0];
	if (first === "--help" || first === "-h")
		return { command: "help", flags: {} };
	if (first === "--version" || first === "-v")
		return { command: "version", flags: {} };

	// If first arg starts with --, treat as serve with flags
	const command = first?.startsWith("-") ? "serve" : (first ?? "serve");
	const flags: Record<string, string | boolean> = {};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;

		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			// Check if next arg is a value (doesn't start with --)
			const next = args[i + 1];
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i++; // skip the value
			} else {
				flags[key] = true;
			}
		}
	}

	return { command, flags };
}

// ─── Main dispatch ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const { command, flags } = parseArgs(process.argv);

	switch (command) {
		case "serve":
		case "start":
			await startServer();
			break;

		case "install":
			await installCommand({
				endpoint:
					typeof flags.endpoint === "string" ? flags.endpoint : undefined,
				skipOtlp: flags["skip-otlp"] === true,
				skipService: flags["skip-service"] === true,
			});
			break;

		case "uninstall":
		case "remove":
			await uninstallCommand({
				purge: flags.purge === true,
			});
			break;

		case "status":
			await statusCommand();
			break;

		case "config":
		case "edit":
			await configCommand();
			break;

		case "logs":
			await logsCommand({
				lines:
					typeof flags.lines === "string"
						? Number.parseInt(flags.lines, 10)
						: undefined,
				which:
					flags.stdout === true
						? "stdout"
						: flags.stderr === true
							? "stderr"
							: "both",
			});
			break;

		case "help":
		case "--help":
		case "-h":
			console.log(HELP);
			break;

		case "version":
		case "--version":
		case "-v":
			console.log(getVersion());
			break;

		default:
			console.error(`Unknown command: ${command}`);
			console.error('Run "agent-telemetry help" for usage.');
			process.exit(1);
	}
}

function getVersion(): string {
	try {
		// Read from package.json
		const pkg = require("../package.json");
		return `agent-telemetry v${pkg.version}`;
	} catch {
		return "agent-telemetry (version unknown)";
	}
}

async function startServer(): Promise<void> {
	const telemetry = await startTelemetry();

	// Graceful shutdown
	process.on("SIGTERM", () => {
		telemetry.stop();
		process.exit(0);
	});
	process.on("SIGINT", () => {
		telemetry.stop();
		process.exit(0);
	});
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
	console.error(
		"Fatal error:",
		err instanceof Error ? err.message : String(err),
	);
	if (process.env.AGENT_TELEMETRY_LOG_LEVEL === "debug") {
		console.error(err);
	}
	process.exit(1);
});
