import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let tempDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "agent-telemetry-config-test-"));
	savedEnv = {};
	// Save and clear relevant env vars
	for (const key of [
		"AGENT_TELEMETRY_CONFIG",
		"AGENT_TELEMETRY_HOST",
		"AGENT_TELEMETRY_PORT",
		"AGENT_TELEMETRY_DATA_DIR",
		"AGENT_TELEMETRY_LOG_LEVEL",
		"AGENT_TELEMETRY_UPSTREAM_URL",
		"AGENT_TELEMETRY_UPSTREAM_TOKEN",
	]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.AGENT_TELEMETRY_DATA_DIR = tempDir;
});

afterEach(() => {
	// Restore env vars
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	rmSync(tempDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
	test("default config when no file exists", () => {
		const config = loadConfig();
		expect(config.collect_logs).toBe(true);
		expect(config.collect_metrics).toBe(true);
		expect(config.collect_traces).toBe(true);
		expect(config.agents).toEqual({});
		expect(config.otlp_forwarders).toEqual([]);
		expect(config.server.host).toBe("127.0.0.1");
		expect(config.server.port).toBe(9911);
		expect(config.log_level).toBe("info");
		expect(config.upstream.url).toBe("");
		expect(config.upstream.batch_size).toBe(500);
	});

	test("YAML config file is loaded correctly", () => {
		const yamlContent = `
server:
  host: 0.0.0.0
  port: 8080
collect_logs: false
collect_metrics: false
collect_traces: false
log_level: debug
agents:
  claude_code:
    log_events:
      mode: allow
      list:
        - claude_code.tool_result
        - claude_code.api_request
otlp_forwarders:
  - name: test-forwarder
    url: http://localhost:4318
    auth:
      type: bearer
      token: test-token
    signals:
      - logs
      - metrics
    enabled: true
upstream:
  url: https://upstream.example.com
  batch_size: 100
  interval_ms: 30000
  report_logs: false
  report_metrics: true
`;
		writeFileSync(join(tempDir, "config.yml"), yamlContent);
		const config = loadConfig();
		expect(config.server.host).toBe("0.0.0.0");
		expect(config.server.port).toBe(8080);
		expect(config.collect_logs).toBe(false);
		expect(config.collect_metrics).toBe(false);
		expect(config.collect_traces).toBe(false);
		expect(config.log_level).toBe("debug");
		expect(config.agents.claude_code?.log_events?.mode).toBe("allow");
		expect(config.agents.claude_code?.log_events?.list).toEqual([
			"claude_code.tool_result",
			"claude_code.api_request",
		]);
		expect(config.otlp_forwarders).toHaveLength(1);
		expect(config.otlp_forwarders[0].name).toBe("test-forwarder");
		expect(config.otlp_forwarders[0].url).toBe("http://localhost:4318");
		expect(config.otlp_forwarders[0].auth.type).toBe("bearer");
		expect(config.otlp_forwarders[0].auth.token).toBe("test-token");
		expect(config.otlp_forwarders[0].signals).toEqual(["logs", "metrics"]);
		expect(config.otlp_forwarders[0].enabled).toBe(true);
		expect(config.upstream.url).toBe("https://upstream.example.com");
		expect(config.upstream.batch_size).toBe(100);
		expect(config.upstream.interval_ms).toBe(30000);
		expect(config.upstream.report_logs).toBe(false);
		expect(config.upstream.report_metrics).toBe(true);
	});

	test("AGENT_TELEMETRY_HOST env var overrides config", () => {
		const yamlContent = `
server:
  host: 0.0.0.0
  port: 8080
`;
		writeFileSync(join(tempDir, "config.yml"), yamlContent);
		process.env.AGENT_TELEMETRY_HOST = "192.168.1.100";
		const config = loadConfig();
		expect(config.server.host).toBe("192.168.1.100");
		// port should still come from file
		expect(config.server.port).toBe(8080);
	});

	test("AGENT_TELEMETRY_PORT env var overrides config", () => {
		const yamlContent = `
server:
  host: 0.0.0.0
  port: 8080
`;
		writeFileSync(join(tempDir, "config.yml"), yamlContent);
		process.env.AGENT_TELEMETRY_PORT = "3000";
		const config = loadConfig();
		expect(config.server.port).toBe(3000);
	});

	test("env overrides work even without config file", () => {
		process.env.AGENT_TELEMETRY_HOST = "10.0.0.1";
		process.env.AGENT_TELEMETRY_PORT = "7777";
		const config = loadConfig();
		expect(config.server.host).toBe("10.0.0.1");
		expect(config.server.port).toBe(7777);
	});

	test("AGENT_TELEMETRY_CONFIG env var points to custom config path", () => {
		const customConfigPath = join(tempDir, "custom-config.yml");
		const yamlContent = `
server:
  host: 1.2.3.4
  port: 9999
collect_logs: false
`;
		writeFileSync(customConfigPath, yamlContent);
		process.env.AGENT_TELEMETRY_CONFIG = customConfigPath;
		const config = loadConfig();
		expect(config.server.host).toBe("1.2.3.4");
		expect(config.server.port).toBe(9999);
		expect(config.collect_logs).toBe(false);
	});
});
