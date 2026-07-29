import { describe, expect, test } from "bun:test";
import type { AgentConfig, TelemetryConfig } from "../../src/config.js";
import { parseOtlpLogs } from "../../src/parsers/otel-logs.js";

function makeConfig(agents: Record<string, AgentConfig>): TelemetryConfig {
	return {
		data_dir: "/tmp",
		server: { host: "127.0.0.1", port: 9911 },
		collect_logs: true,
		collect_metrics: true,
		collect_traces: true,
		agents,
		upstream: {
			url: "",
			batch_size: 500,
			interval_ms: 600_000,
			report_logs: true,
			report_metrics: true,
		},
		otlp_forwarders: [],
		log_level: "info",
	};
}

const VALID_PAYLOAD = JSON.stringify({
	resourceLogs: [
		{
			resource: {
				attributes: [
					{ key: "service.name", value: { stringValue: "claude-code" } },
				],
			},
			scopeLogs: [
				{
					logRecords: [
						{
							timeUnixNano: "1737500000000000000",
							body: { stringValue: "claude_code.tool_result" },
							attributes: [
								{ key: "tool_name", value: { stringValue: "Bash" } },
								{ key: "session.id", value: { stringValue: "test-session-1" } },
								{ key: "success", value: { stringValue: "true" } },
							],
						},
					],
				},
			],
		},
	],
});

describe("parseOtlpLogs", () => {
	test("parses valid Claude Code OTLP JSON into LogEventInsert rows", () => {
		const rows = parseOtlpLogs(VALID_PAYLOAD);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.provider).toBe("claude");
		expect(row.category).toBe("tool");
		expect(row.event_name).toBe("claude_code.tool_result");
		expect(row.tool_name).toBe("Bash");
		expect(row.success).toBe("true");
		expect(row.session_id).toBe("test-session-1");
		expect(row.user_id).toBeNull();
		expect(row.duration_ms).toBeNull();
		expect(row.timestamp_nano).toBe("1737500000000000000");
	});

	test("parses resource attributes into resource JSON", () => {
		const rows = parseOtlpLogs(VALID_PAYLOAD);
		expect(rows[0].resource).toBe('{"service.name":"claude-code"}');
	});

	test("serializes attributes to JSON correctly", () => {
		const rows = parseOtlpLogs(VALID_PAYLOAD);
		const attrs = JSON.parse(rows[0].attributes);
		expect(attrs.tool_name).toBe("Bash");
		expect(attrs["session.id"]).toBe("test-session-1");
		expect(attrs.success).toBe("true");
	});

	test("empty resourceLogs returns empty result", () => {
		expect(parseOtlpLogs(JSON.stringify({ resourceLogs: [] }))).toEqual([]);
	});

	test("missing resourceLogs key returns empty result", () => {
		expect(parseOtlpLogs(JSON.stringify({}))).toEqual([]);
	});

	test("filtering with allow mode returns only matching events", () => {
		const payload = JSON.stringify({
			resourceLogs: [
				{
					resource: { attributes: [] },
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1737500000000000000",
									body: { stringValue: "claude_code.tool_result" },
									attributes: [
										{ key: "tool_name", value: { stringValue: "Bash" } },
									],
								},
								{
									timeUnixNano: "1737500001000000000",
									body: { stringValue: "claude_code.api_request" },
									attributes: [],
								},
							],
						},
					],
				},
			],
		});
		const config = makeConfig({
			claude_code: {
				log_events: { mode: "allow", list: ["claude_code.tool_result"] },
			},
		});
		const rows = parseOtlpLogs(payload, config);
		expect(rows).toHaveLength(1);
		expect(rows[0].event_name).toBe("claude_code.tool_result");
	});

	test("filtering with deny mode drops excluded events", () => {
		const payload = JSON.stringify({
			resourceLogs: [
				{
					resource: { attributes: [] },
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1737500000000000000",
									body: { stringValue: "claude_code.tool_result" },
									attributes: [
										{ key: "tool_name", value: { stringValue: "Bash" } },
									],
								},
								{
									timeUnixNano: "1737500001000000000",
									body: { stringValue: "claude_code.api_request" },
									attributes: [],
								},
							],
						},
					],
				},
			],
		});
		const config = makeConfig({
			claude_code: {
				log_events: { mode: "deny", list: ["claude_code.tool_result"] },
			},
		});
		const rows = parseOtlpLogs(payload, config);
		expect(rows).toHaveLength(1);
		expect(rows[0].event_name).toBe("claude_code.api_request");
	});

	test("filtering with all mode returns all events", () => {
		const payload = JSON.stringify({
			resourceLogs: [
				{
					resource: { attributes: [] },
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1737500000000000000",
									body: { stringValue: "claude_code.tool_result" },
									attributes: [
										{ key: "tool_name", value: { stringValue: "Bash" } },
									],
								},
								{
									timeUnixNano: "1737500001000000000",
									body: { stringValue: "claude_code.api_request" },
									attributes: [],
								},
							],
						},
					],
				},
			],
		});
		const config = makeConfig({
			claude_code: { log_events: { mode: "all", list: [] } },
		});
		const rows = parseOtlpLogs(payload, config);
		expect(rows).toHaveLength(2);
	});

	test("category mapping: tool_result → tool, api_request → api, skill_activated → skill, etc.", () => {
		const payload = JSON.stringify({
			resourceLogs: [
				{
					resource: { attributes: [] },
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1",
									body: { stringValue: "claude_code.tool_result" },
									attributes: [
										{ key: "tool_name", value: { stringValue: "Bash" } },
									],
								},
								{
									timeUnixNano: "2",
									body: { stringValue: "claude_code.tool_result" },
									attributes: [
										{ key: "tool_name", value: { stringValue: "mcp_tool" } },
									],
								},
								{
									timeUnixNano: "3",
									body: { stringValue: "claude_code.api_request" },
									attributes: [],
								},
								{
									timeUnixNano: "4",
									body: { stringValue: "claude_code.skill_activated" },
									attributes: [
										{ key: "skill.name", value: { stringValue: "my-skill" } },
									],
								},
								{
									timeUnixNano: "5",
									body: { stringValue: "claude_code.mcp_server_connection" },
									attributes: [],
								},
								{
									timeUnixNano: "6",
									body: { stringValue: "claude_code.tool_decision" },
									attributes: [],
								},
								{
									timeUnixNano: "7",
									body: { stringValue: "claude_code.user_prompt" },
									attributes: [],
								},
								{
									timeUnixNano: "8",
									body: { stringValue: "claude_code.compaction" },
									attributes: [],
								},
								{
									timeUnixNano: "9",
									body: { stringValue: "claude_code.permission_mode_changed" },
									attributes: [],
								},
								{
									timeUnixNano: "10",
									body: { stringValue: "claude_code.hook_execution_complete" },
									attributes: [],
								},
								{
									timeUnixNano: "11",
									body: { stringValue: "claude_code.api_error" },
									attributes: [
										{ key: "status_code", value: { intValue: 500 } },
									],
								},
							],
						},
					],
				},
			],
		});
		const rows = parseOtlpLogs(payload);
		const categories = rows.map((r) => ({
			event: r.event_name,
			category: r.category,
		}));
		expect(categories).toEqual([
			{ event: "claude_code.tool_result", category: "tool" },
			{ event: "claude_code.tool_result", category: "mcp" },
			{ event: "claude_code.api_request", category: "api" },
			{ event: "claude_code.skill_activated", category: "skill" },
			{
				event: "claude_code.mcp_server_connection",
				category: "mcp_connection",
			},
			{ event: "claude_code.tool_decision", category: "tool_decision" },
			{ event: "claude_code.user_prompt", category: "user_prompt" },
			{ event: "claude_code.compaction", category: "compaction" },
			{ event: "claude_code.permission_mode_changed", category: "permission" },
			{ event: "claude_code.hook_execution_complete", category: "hook" },
			{ event: "claude_code.api_error", category: "api" },
		]);
	});

	test("missing event_name (body.stringValue is empty) → skipped", () => {
		const payload = JSON.stringify({
			resourceLogs: [
				{
					resource: { attributes: [] },
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1",
									body: { stringValue: "" },
									attributes: [],
								},
								{ timeUnixNano: "2", body: {}, attributes: [] },
								{ timeUnixNano: "3", attributes: [] },
								{
									timeUnixNano: "4",
									body: { stringValue: "claude_code.tool_result" },
									attributes: [
										{ key: "tool_name", value: { stringValue: "Bash" } },
									],
								},
							],
						},
					],
				},
			],
		});
		const rows = parseOtlpLogs(payload);
		expect(rows).toHaveLength(1);
		expect(rows[0].event_name).toBe("claude_code.tool_result");
	});

	test("intValue attributes are correctly serialized to JSON", () => {
		const payload = JSON.stringify({
			resourceLogs: [
				{
					resource: { attributes: [] },
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: "1",
									body: { stringValue: "claude_code.api_request" },
									attributes: [
										{ key: "status_code", value: { intValue: 200 } },
										{ key: "duration_ms", value: { intValue: 150 } },
										{ key: "model", value: { stringValue: "claude-3-opus" } },
									],
								},
							],
						},
					],
				},
			],
		});
		const rows = parseOtlpLogs(payload);
		expect(rows).toHaveLength(1);
		const attrs = JSON.parse(rows[0].attributes);
		expect(attrs.status_code).toBe("200");
		expect(attrs.duration_ms).toBe("150");
		expect(attrs.model).toBe("claude-3-opus");
		expect(rows[0].duration_ms).toBe(150);
	});
});
