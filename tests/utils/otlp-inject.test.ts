import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_OTLP_ENDPOINT,
	injectClaudeCodeOtlp,
	removeClaudeCodeOtlp,
} from "../../src/utils/otlp-inject.js";

let tempHome: string;
let savedHome: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "agent-telemetry-inject-test-"));
	savedHome = process.env.HOME;
	process.env.HOME = tempHome;
});

afterEach(() => {
	if (savedHome === undefined) {
		process.env.HOME = undefined;
	} else {
		process.env.HOME = savedHome;
	}
	rmSync(tempHome, { recursive: true, force: true });
});

function readClaudeSettings(): Record<string, unknown> {
	const settingsPath = join(tempHome, ".claude", "settings.json");
	return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

describe("injectClaudeCodeOtlp", () => {
	test("writes OTEL_* vars to settings.json", () => {
		const result = injectClaudeCodeOtlp();
		expect(result.changed).toBe(true);
		expect(result.path).toBe(join(tempHome, ".claude", "settings.json"));

		const settings = readClaudeSettings();
		const env = settings.env as Record<string, string>;
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
		expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe("1");
		expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
		expect(env.OTEL_METRICS_EXPORTER).toBe("otlp");
		expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
		expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(DEFAULT_OTLP_ENDPOINT);
		expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1");
	});

	test("creates .claude directory if it does not exist", () => {
		expect(existsSync(join(tempHome, ".claude"))).toBe(false);
		injectClaudeCodeOtlp();
		expect(existsSync(join(tempHome, ".claude", "settings.json"))).toBe(true);
	});

	test("preserves existing env vars in settings.json", () => {
		// Pre-populate settings.json with existing env vars
		const claudeDir = join(tempHome, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({
				env: { MY_CUSTOM_VAR: "custom-value", ANOTHER_VAR: "keep-me" },
			}),
		);

		injectClaudeCodeOtlp();
		const settings = readClaudeSettings();
		const env = settings.env as Record<string, string>;
		expect(env.MY_CUSTOM_VAR).toBe("custom-value");
		expect(env.ANOTHER_VAR).toBe("keep-me");
		expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
	});

	test("preserves non-env keys in settings.json", () => {
		const claudeDir = join(tempHome, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash"] }, theme: "dark" }),
		);

		injectClaudeCodeOtlp();
		const settings = readClaudeSettings();
		expect(settings.permissions).toEqual({ allow: ["Bash"] });
		expect(settings.theme).toBe("dark");
	});

	test("idempotent — running twice does not report changes", () => {
		const first = injectClaudeCodeOtlp();
		expect(first.changed).toBe(true);
		expect(first.keysAdded.length).toBeGreaterThan(0);

		const second = injectClaudeCodeOtlp();
		expect(second.changed).toBe(false);
		expect(second.keysAdded).toEqual([]);
		expect(second.keysUpdated).toEqual([]);
	});

	test("custom endpoint is reflected in OTEL_EXPORTER_OTLP_ENDPOINT", () => {
		const customEndpoint = "http://10.0.0.1:8080/api/otel";
		injectClaudeCodeOtlp(customEndpoint);
		const settings = readClaudeSettings();
		const env = settings.env as Record<string, string>;
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(customEndpoint);
	});
});

describe("removeClaudeCodeOtlp", () => {
	test("removes OTEL_* vars but preserves other env vars", () => {
		// First inject
		const claudeDir = join(tempHome, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({
				env: { MY_CUSTOM_VAR: "custom-value", KEEP_ME: "yes" },
			}),
		);
		injectClaudeCodeOtlp();

		// Now remove
		const removed = removeClaudeCodeOtlp();
		expect(removed).toBeGreaterThan(0);

		const settings = readClaudeSettings();
		const env = settings.env as Record<string, string>;
		// OTEL vars should be gone
		expect(env.OTEL_TRACES_EXPORTER).toBeUndefined();
		expect(env.OTEL_METRICS_EXPORTER).toBeUndefined();
		expect(env.OTEL_LOGS_EXPORTER).toBeUndefined();
		expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBeUndefined();
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
		// Custom vars should be preserved
		expect(env.MY_CUSTOM_VAR).toBe("custom-value");
		expect(env.KEEP_ME).toBe("yes");
	});

	test("returns 0 when settings.json does not exist", () => {
		expect(existsSync(join(tempHome, ".claude", "settings.json"))).toBe(false);
		const removed = removeClaudeCodeOtlp();
		expect(removed).toBe(0);
	});

	test("returns 0 when no OTEL vars present", () => {
		const claudeDir = join(tempHome, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({ env: { FOO: "bar" } }),
		);
		const removed = removeClaudeCodeOtlp();
		expect(removed).toBe(0);
		// Other env var is preserved
		const settings = readClaudeSettings();
		expect((settings.env as Record<string, string>).FOO).toBe("bar");
	});
});
