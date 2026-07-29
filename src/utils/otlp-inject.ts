/**
 * OTLP Config Injection
 *
 * Injects/removes OTLP telemetry environment variables into:
 *   - Claude Code: ~/.claude/settings.json (env section)
 *   - Codex:       ~/.codex/config.toml   ([otel] section)
 *   - OpenCode:    ~/.zshrc or ~/.bashrc  (OTEL_EXPORTER_* env vars)
 *
 * All injection points are idempotent: running twice doesn't duplicate or
 * corrupt anything. Removal preserves all unrelated keys.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default OTLP endpoint — agent-telemetry's HTTP server */
export const DEFAULT_OTLP_ENDPOINT = "http://127.0.0.1:9911/api/otel";

/** Marker stored in injected config so we can identify our own keys on removal */
const INJECTION_MARKER = "agent-telemetry";

/** Claude Code env vars that agent-telemetry manages */
const CLAUDE_CODE_OTEL_KEYS = [
	"CLAUDE_CODE_ENABLE_TELEMETRY",
	"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
	"OTEL_TRACES_EXPORTER",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_LOG_TOOL_DETAILS",
] as const;

/** Additional DCC-compatible keys we also inject (not harmful, improves tracing) */
const CLAUDE_CODE_EXTRA_KEYS = [
	"OTEL_SERVICE_NAME",
	"CLAUDE_CODE_PROPAGATE_TRACEPARENT",
	"ENABLE_BETA_TRACING_DETAILED",
	"BETA_TRACING_ENDPOINT",
	"OTEL_RESOURCE_ATTRIBUTES",
] as const;

/** All keys we manage (for removal) */
const ALL_MANAGED_KEYS = [...CLAUDE_CODE_OTEL_KEYS, ...CLAUDE_CODE_EXTRA_KEYS];

// ─── Types ───────────────────────────────────────────────────────────────────

type ClaudeSettings = {
	env?: Record<string, string>;
	[key: string]: unknown;
};

type InjectionResult = {
	changed: boolean;
	path: string;
	keysAdded: string[];
	keysUpdated: string[];
};

// ─── Path helpers ────────────────────────────────────────────────────────────

function getClaudeSettingsPath(): string {
	return join(process.env.HOME ?? "~", ".claude", "settings.json");
}

function getCodexConfigPath(): string {
	return join(process.env.HOME ?? "~", ".codex", "config.toml");
}

function getDataDir(): string {
	return join(process.env.HOME ?? "~", ".agent-telemetry");
}

/** Detect the user's shell profile file (~/.zshrc on macOS, ~/.bashrc on Linux). */
function getShellProfilePath(): string {
	const home = process.env.HOME ?? "~";
	// On macOS the default shell is zsh; on Linux it's bash.
	// Fall back to ~/.bashrc if ~/.zshrc doesn't exist and we're not on macOS.
	const shell = process.env.SHELL ?? "";
	if (shell.includes("zsh") || process.platform === "darwin") {
		return join(home, ".zshrc");
	}
	return join(home, ".bashrc");
}

// ─── Claude Code injection ───────────────────────────────────────────────────

/**
 * Build the OTEL env vars to inject into Claude Code's settings.json.
 */
function buildClaudeCodeOtelEnv(endpoint: string): Record<string, string> {
	const base = endpoint.replace(/\/+$/, "");
	return {
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
		OTEL_EXPORTER_OTLP_ENDPOINT: base,
		OTEL_LOG_TOOL_DETAILS: "1",
		OTEL_SERVICE_NAME: "claude-code",
		CLAUDE_CODE_PROPAGATE_TRACEPARENT: "1",
		ENABLE_BETA_TRACING_DETAILED: "1",
		BETA_TRACING_ENDPOINT: base,
		OTEL_RESOURCE_ATTRIBUTES: "service.name=claude-code",
	};
}

/**
 * Inject OTEL env vars into Claude Code's ~/.claude/settings.json.
 *
 * - Creates the file/directory if it doesn't exist
 * - Merges into the existing `env` object (preserves unrelated env vars)
 * - Idempotent: only writes if values actually changed
 *
 * @returns InjectionResult describing what changed
 */
export function injectClaudeCodeOtlp(
	endpoint: string = DEFAULT_OTLP_ENDPOINT,
): InjectionResult {
	const settingsPath = getClaudeSettingsPath();
	const dir = join(settingsPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	let settings: ClaudeSettings = {};
	if (existsSync(settingsPath)) {
		try {
			const raw = readFileSync(settingsPath, "utf-8");
			settings = JSON.parse(raw) as ClaudeSettings;
		} catch (err) {
			logger.warn(
				"Failed to parse {path}, backing up and creating fresh: {error}",
				{
					path: settingsPath,
					error: err instanceof Error ? err.message : String(err),
				},
			);
			// Backup the corrupt file so we don't destroy user data
			try {
				writeFileSync(
					`${settingsPath}.bak.${Date.now()}`,
					readFileSync(settingsPath),
				);
			} catch {
				// ignore backup failure
			}
			settings = {};
		}
	}

	// Ensure env is an object
	const existingEnv =
		typeof settings.env === "object" &&
		settings.env !== null &&
		!Array.isArray(settings.env)
			? (settings.env as Record<string, string>)
			: {};

	const otelEnv = buildClaudeCodeOtelEnv(endpoint);
	const keysAdded: string[] = [];
	const keysUpdated: string[] = [];

	for (const [key, value] of Object.entries(otelEnv)) {
		if (!(key in existingEnv)) {
			keysAdded.push(key);
		} else if (existingEnv[key] !== value) {
			keysUpdated.push(key);
		}
		existingEnv[key] = value;
	}

	const changed = keysAdded.length > 0 || keysUpdated.length > 0;
	if (changed) {
		settings.env = existingEnv;
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
		logger.info("Injected OTLP env into Claude Code settings", {
			path: settingsPath,
			added: keysAdded.length,
			updated: keysUpdated.length,
		});
	} else {
		logger.debug("Claude Code OTLP env already up to date", {
			path: settingsPath,
		});
	}

	return { changed, path: settingsPath, keysAdded, keysUpdated };
}

/**
 * Remove all agent-telemetry-managed OTEL env vars from Claude Code's settings.json.
 * Preserves all other env vars and settings.
 *
 * @returns number of keys removed
 */
export function removeClaudeCodeOtlp(): number {
	const settingsPath = getClaudeSettingsPath();
	if (!existsSync(settingsPath)) return 0;

	let settings: ClaudeSettings;
	try {
		settings = JSON.parse(
			readFileSync(settingsPath, "utf-8"),
		) as ClaudeSettings;
	} catch (err) {
		logger.warn("Failed to parse {path}, skipping removal: {error}", {
			path: settingsPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return 0;
	}

	const env = settings.env;
	if (typeof env !== "object" || env === null || Array.isArray(env)) return 0;

	let removed = 0;
	for (const key of ALL_MANAGED_KEYS) {
		if (key in env) {
			delete env[key];
			removed++;
		}
	}

	if (removed > 0) {
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
		logger.info("Removed OTLP env from Claude Code settings", {
			path: settingsPath,
			removed,
		});
	}

	return removed;
}

// ─── Codex injection ─────────────────────────────────────────────────────────

/**
 * Build the [otel] TOML section for Codex's config.toml.
 *
 * Codex's OTLP SDK does NOT append signal paths to a base endpoint — it POSTs
 * the endpoint verbatim. So each exporter must carry a full per-signal path:
 *   - [otel.exporter.otlp-http] → /v1/logs
 *   - [otel.metrics_exporter.otlp-http] → /v1/metrics
 */
function buildCodexOtelSection(endpoint: string): string {
	const base = endpoint
		.replace(/\/+$/, "")
		.replace(/\/api\/otel$/, "/api/otel");
	return [
		"[otel]",
		`environment = "production"`,
		`# Managed by ${INJECTION_MARKER}`,
		"",
		"[otel.exporter.otlp-http]",
		`endpoint = "${base}/v1/logs"`,
		`protocol = "json"`,
		"",
		"[otel.metrics_exporter.otlp-http]",
		`endpoint = "${base}/v1/metrics"`,
		`protocol = "json"`,
		"",
	].join("\n");
}

/**
 * Remove all [otel*] sections from a TOML config string.
 * Matches [otel], [otel.exporter.*], [otel.metrics_exporter.*], etc.
 */
function removeCodexOtelSections(content: string): string {
	// Remove all [otel...] sections and their key-value lines
	return content.replace(/^\[otel[^\]]*\][^\[]*(?:\n(?!\[)|)*/gm, "");
}

/**
 * Check if the codex config already has an agent-telemetry-managed [otel] section
 * pointing at the given endpoint.
 */
function hasCurrentOtelSection(content: string, endpoint: string): boolean {
	const base = endpoint.replace(/\/+$/, "");
	const expectedLogs = `${base}/v1/logs`;
	const expectedMetrics = `${base}/v1/metrics`;
	return (
		content.includes(`endpoint = "${expectedLogs}"`) &&
		content.includes(`endpoint = "${expectedMetrics}"`)
	);
}

/**
 * Inject OTLP config into Codex's ~/.codex/config.toml.
 *
 * - Creates the file/directory if it doesn't exist
 * - Removes any existing [otel*] sections, then appends the new one
 * - Idempotent: skips write if already correct
 *
 * @returns InjectionResult describing what changed
 */
export function injectCodexOtlp(
	endpoint: string = DEFAULT_OTLP_ENDPOINT,
): InjectionResult {
	const configPath = getCodexConfigPath();
	const dir = join(configPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	let content = "";
	if (existsSync(configPath)) {
		content = readFileSync(configPath, "utf-8");
	}

	// Check if already correct
	if (hasCurrentOtelSection(content, endpoint)) {
		logger.debug("Codex OTLP config already up to date", { path: configPath });
		return { changed: false, path: configPath, keysAdded: [], keysUpdated: [] };
	}

	// Remove existing [otel*] sections
	const cleaned = removeCodexOtelSections(content);
	const otelSection = buildCodexOtelSection(endpoint);

	// Ensure file ends with newline before appending
	const newContent =
		cleaned && !cleaned.endsWith("\n")
			? `${cleaned}\n\n${otelSection}`
			: `${cleaned}\n${otelSection}`;

	writeFileSync(configPath, newContent);
	logger.info("Injected OTLP config into Codex config.toml", {
		path: configPath,
	});

	return {
		changed: true,
		path: configPath,
		keysAdded: [
			"[otel]",
			"[otel.exporter.otlp-http]",
			"[otel.metrics_exporter.otlp-http]",
		],
		keysUpdated: [],
	};
}

/**
 * Remove all [otel*] sections from Codex's config.toml.
 * Preserves all other configuration.
 *
 * @returns true if anything was removed
 */
export function removeCodexOtlp(): boolean {
	const configPath = getCodexConfigPath();
	if (!existsSync(configPath)) return false;

	const content = readFileSync(configPath, "utf-8");

	// Check if there's an [otel] section to remove
	if (!/^\[otel[^\]]*\]/m.test(content)) return false;

	const cleaned = removeCodexOtelSections(content);
	// Clean up extra blank lines left behind
	const trimmed = cleaned.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");

	writeFileSync(configPath, trimmed);
	logger.info("Removed OTLP config from Codex config.toml", {
		path: configPath,
	});
	return true;
}

// ─── OpenCode env var injection (shell profile) ──────────────────────────────

/** Marker comments that delimit agent-telemetry's injected block in the shell profile */
const OPENCODE_BEGIN_MARKER = "# agent-telemetry:opencode";
const OPENCODE_END_MARKER = "# end agent-telemetry:opencode";

/**
 * Build the OTLP env var block for OpenCode.
 * OpenCode reads standard OTEL_EXPORTER_OTLP_* env vars at runtime.
 */
function buildOpenCodeEnvBlock(endpoint: string): string {
	const base = endpoint.replace(/\/+$/, "");
	return [
		OPENCODE_BEGIN_MARKER,
		`export OTEL_EXPORTER_OTLP_ENDPOINT="${base}"`,
		`export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"`,
		OPENCODE_END_MARKER,
	].join("\n");
}

/**
 * Inject OTLP env vars into the user's shell profile (~/.zshrc or ~/.bashrc).
 *
 * OpenCode natively sends OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set in the
 * environment. Since OpenCode is a CLI tool, env vars must be in the shell
 * profile to be available when the user runs `opencode`.
 *
 * - Creates the shell profile file if it doesn't exist
 * - Replaces any existing agent-telemetry block (idempotent)
 * - Preserves all other content in the file
 *
 * @returns InjectionResult describing what changed
 */
export function injectOpenCodeOtlp(
	endpoint: string = DEFAULT_OTLP_ENDPOINT,
): InjectionResult {
	const profilePath = getShellProfilePath();
	const envBlock = buildOpenCodeEnvBlock(endpoint);

	let content = "";
	if (existsSync(profilePath)) {
		content = readFileSync(profilePath, "utf-8");
	}

	// Check if our block already exists with the correct endpoint
	const blockRegex = new RegExp(
		`${OPENCODE_BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${OPENCODE_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
	);
	const existingBlock = content.match(blockRegex);

	if (existingBlock && existingBlock[0] === envBlock) {
		logger.debug("OpenCode OTLP env vars already up to date", {
			path: profilePath,
		});
		return {
			changed: false,
			path: profilePath,
			keysAdded: [],
			keysUpdated: [],
		};
	}

	// Remove any existing agent-telemetry block, then append the new one
	let cleaned = content.replace(blockRegex, "").replace(/\n{3,}/g, "\n\n");
	// Ensure file ends with newline before appending
	if (cleaned && !cleaned.endsWith("\n")) {
		cleaned = `${cleaned}\n`;
	}
	const newContent = `${cleaned}\n${envBlock}\n`;

	writeFileSync(profilePath, newContent);
	logger.info("Injected OTLP env vars for OpenCode into shell profile", {
		path: profilePath,
	});

	return {
		changed: true,
		path: profilePath,
		keysAdded: ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL"],
		keysUpdated: [],
	};
}

/**
 * Remove agent-telemetry's OTLP env var block from the user's shell profile.
 * Preserves all other content.
 *
 * @returns true if anything was removed
 */
export function removeOpenCodeOtlp(): boolean {
	const profilePath = getShellProfilePath();
	if (!existsSync(profilePath)) return false;

	const content = readFileSync(profilePath, "utf-8");

	const blockRegex = new RegExp(
		`${OPENCODE_BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${OPENCODE_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n*`,
	);
	if (!blockRegex.test(content)) return false;

	const cleaned = content.replace(blockRegex, "").replace(/\n{3,}/g, "\n\n");
	writeFileSync(profilePath, cleaned);
	logger.info("Removed OTLP env vars for OpenCode from shell profile", {
		path: profilePath,
	});
	return true;
}

// ─── Combined injection/removal ──────────────────────────────────────────────

/**
 * Inject OTLP config into Claude Code, Codex, and OpenCode (if installed).
 */
export function injectAllOtlp(endpoint: string = DEFAULT_OTLP_ENDPOINT): {
	claudeCode: InjectionResult;
	codex: InjectionResult | null;
	opencode: InjectionResult | null;
} {
	const claudeCode = injectClaudeCodeOtlp(endpoint);

	// Only inject into Codex if ~/.codex exists (don't create it)
	let codex: InjectionResult | null = null;
	const codexDir = join(process.env.HOME ?? "~", ".codex");
	if (existsSync(codexDir)) {
		codex = injectCodexOtlp(endpoint);
	} else {
		logger.info(
			"Codex not detected (~/.codex not found), skipping Codex OTLP injection",
		);
	}

	// Only inject OpenCode env vars if OpenCode is installed (~/.config/opencode exists)
	let opencode: InjectionResult | null = null;
	const opencodeDir = join(process.env.HOME ?? "~", ".config", "opencode");
	if (existsSync(opencodeDir)) {
		opencode = injectOpenCodeOtlp(endpoint);
	} else {
		logger.info(
			"OpenCode not detected (~/.config/opencode not found), skipping OpenCode OTLP injection",
		);
	}

	return { claudeCode, codex, opencode };
}

/**
 * Remove OTLP config from Claude Code, Codex, and OpenCode.
 */
export function removeAllOtlp(): {
	claudeCodeRemoved: number;
	codexRemoved: boolean;
	opencodeRemoved: boolean;
} {
	const claudeCodeRemoved = removeClaudeCodeOtlp();
	const codexRemoved = removeCodexOtlp();
	const opencodeRemoved = removeOpenCodeOtlp();
	return { claudeCodeRemoved, codexRemoved, opencodeRemoved };
}

// ─── Config file copy helper ─────────────────────────────────────────────────

/**
 * Copy the default config.yml to the data directory if it doesn't already exist.
 */
export function ensureConfigFile(sourceConfigPath: string): boolean {
	const dataDir = getDataDir();
	const destPath = join(dataDir, "config.yml");

	if (!existsSync(dataDir)) {
		mkdirSync(dataDir, { recursive: true });
	}

	if (existsSync(destPath)) {
		logger.debug("Config file already exists, skipping copy", {
			path: destPath,
		});
		return false;
	}

	if (existsSync(sourceConfigPath)) {
		const content = readFileSync(sourceConfigPath, "utf-8");
		writeFileSync(destPath, content);
		logger.info("Copied config template to data directory", {
			from: sourceConfigPath,
			to: destPath,
		});
		return true;
	}

	logger.warn("Source config template not found", { path: sourceConfigPath });
	return false;
}
