import { describe, expect, test } from "bun:test";
import type { AgentConfig, TelemetryConfig } from "../../src/config.js";
import { parseOpencodeOtlpLogRecord } from "../../src/parsers/otel-opencode-logs.js";

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

const RESOURCE_JSON = '{"service.name":"opencode"}';

function makeRecord(
	message: string | undefined,
	attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number } }> = [],
	timeUnixNano = "1737500000000000000",
) {
	return {
		timeUnixNano,
		body: message !== undefined ? { stringValue: message } : null,
		attributes,
	};
}

describe("parseOpencodeOtlpLogRecord", () => {
	test("parses a stream event (LLM API call)", () => {
		const record = makeRecord("stream", [
			{ key: "session.id", value: { stringValue: "sess-123" } },
			{ key: "providerID", value: { stringValue: "anthropic" } },
			{ key: "modelID", value: { stringValue: "claude-sonnet-4" } },
			{ key: "agent", value: { stringValue: "build" } },
			{ key: "mode", value: { stringValue: "primary" } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.provider).toBe("opencode");
		expect(row!.event_name).toBe("opencode.stream");
		expect(row!.category).toBe("api");
		expect(row!.session_id).toBe("sess-123");
		expect(row!.success).toBeNull();
		expect(row!.tool_name).toBeNull();
		expect(row!.duration_ms).toBeNull();
		expect(row!.timestamp_nano).toBe("1737500000000000000");
		expect(row!.user_id).toBeNull();
		expect(row!.resource).toBe(RESOURCE_JSON);
	});

	test("parses a command event (user_prompt)", () => {
		const record = makeRecord("command", [
			{ key: "session.id", value: { stringValue: "sess-456" } },
			{ key: "command", value: { stringValue: "write a function" } },
			{ key: "agent", value: { stringValue: "build" } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.command");
		expect(row!.category).toBe("user_prompt");
	});

	test("parses a created event (session lifecycle)", () => {
		const record = makeRecord("created", [{ key: "session.id", value: { stringValue: "sess-789" } }]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.created");
		expect(row!.category).toBe("session");
	});

	test("parses a pruned event (compaction)", () => {
		const record = makeRecord("pruned", [
			{ key: "count", value: { intValue: 10 } },
			{ key: "total", value: { intValue: 50 } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.pruned");
		expect(row!.category).toBe("compaction");
	});

	test("parses a mcp resource event", () => {
		const record = makeRecord("mcp resource", [
			{ key: "session.id", value: { stringValue: "sess-mcp" } },
			{ key: "server", value: { stringValue: "my-server" } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.mcp resource");
		expect(row!.category).toBe("mcp");
	});

	test("parses a failed to generate title event (error)", () => {
		const record = makeRecord("failed to generate title", [
			{ key: "session.id", value: { stringValue: "sess-err" } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.failed to generate title");
		expect(row!.category).toBe("error");
	});

	test("parses a stream error event (error)", () => {
		const record = makeRecord("stream error");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.stream error");
		expect(row!.category).toBe("error");
	});

	test("parses a shell tool using shell event (tool)", () => {
		const record = makeRecord("shell tool using shell");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.shell tool using shell");
		expect(row!.category).toBe("tool");
	});

	test("extracts tool.name attribute into tool_name", () => {
		const record = makeRecord("file", [
			{ key: "session.id", value: { stringValue: "sess-tool" } },
			{ key: "tool.name", value: { stringValue: "edit" } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.tool_name).toBe("edit");
	});

	test("extracts tool_name attribute into tool_name (fallback)", () => {
		const record = makeRecord("file", [
			{ key: "tool_name", value: { stringValue: "bash" } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.tool_name).toBe("bash");
	});

	test("extracts duration_ms from attributes", () => {
		const record = makeRecord("stream", [
			{ key: "duration_ms", value: { intValue: 1500 } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.duration_ms).toBe(1500);
	});

	test("falls back to 'duration' attribute for duration_ms", () => {
		const record = makeRecord("stream", [
			{ key: "duration", value: { intValue: 2000 } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.duration_ms).toBe(2000);
	});

	test("serializes attributes to JSON", () => {
		const record = makeRecord("stream", [
			{ key: "session.id", value: { stringValue: "sess-json" } },
			{ key: "providerID", value: { stringValue: "anthropic" } },
			{ key: "count", value: { intValue: 42 } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		const attrs = JSON.parse(row!.attributes);
		expect(attrs["session.id"]).toBe("sess-json");
		expect(attrs.providerID).toBe("anthropic");
		expect(attrs.count).toBe("42");
	});

	test("passes user_id from resource", () => {
		const record = makeRecord("stream", []);
		const row = parseOpencodeOtlpLogRecord(record, "user-abc", RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.user_id).toBe("user-abc");
	});

	test("returns null when body.stringValue is missing", () => {
		const record = makeRecord(undefined);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).toBeNull();
	});

	test("returns null when body is empty string", () => {
		const record = makeRecord("");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).toBeNull();
	});

	test("returns null when body is null", () => {
		const record = {
			timeUnixNano: "1",
			body: null,
			attributes: [],
		};
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).toBeNull();
	});

	test("config filtering: allow mode only collects listed events", () => {
		const config = makeConfig({
			opencode: {
				log_events: { mode: "allow", list: ["opencode.stream"] },
			},
		});
		const streamRecord = makeRecord("stream", [{ key: "session.id", value: { stringValue: "s1" } }]);
		const commandRecord = makeRecord("command", [{ key: "session.id", value: { stringValue: "s2" } }]);

		expect(parseOpencodeOtlpLogRecord(streamRecord, null, RESOURCE_JSON, config)).not.toBeNull();
		expect(parseOpencodeOtlpLogRecord(commandRecord, null, RESOURCE_JSON, config)).toBeNull();
	});

	test("config filtering: deny mode collects all except listed", () => {
		const config = makeConfig({
			opencode: {
				log_events: { mode: "deny", list: ["opencode.command"] },
			},
		});
		const streamRecord = makeRecord("stream");
		const commandRecord = makeRecord("command");

		expect(parseOpencodeOtlpLogRecord(streamRecord, null, RESOURCE_JSON, config)).not.toBeNull();
		expect(parseOpencodeOtlpLogRecord(commandRecord, null, RESOURCE_JSON, config)).toBeNull();
	});

	test("config filtering: all mode collects everything", () => {
		const config = makeConfig({
			opencode: {
				log_events: { mode: "all", list: [] },
			},
		});
		const record = makeRecord("some unknown message");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON, config);
		expect(row).not.toBeNull();
		expect(row!.category).toBe("other");
	});

	test("unknown messages get category 'other'", () => {
		const record = makeRecord("some random unknown event");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.category).toBe("other");
		expect(row!.event_name).toBe("opencode.some random unknown event");
	});

	test("messages containing 'sync' get category 'other'", () => {
		const record = makeRecord("file system sync");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.category).toBe("other");
	});

	test("messages containing 'connected' get category 'other'", () => {
		const record = makeRecord("mcp server connected");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.category).toBe("other");
	});

	test("loop event gets session category", () => {
		const record = makeRecord("loop", [
			{ key: "session.id", value: { stringValue: "sess-loop" } },
			{ key: "step", value: { intValue: 3 } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.event_name).toBe("opencode.loop");
		expect(row!.category).toBe("session");
	});

	test("llm runtime selected event gets api category", () => {
		const record = makeRecord("llm runtime selected");
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.category).toBe("api");
	});

	test("tail fallback event gets compaction category", () => {
		const record = makeRecord("tail fallback", [
			{ key: "budget", value: { intValue: 1000 } },
			{ key: "size", value: { intValue: 500 } },
			{ key: "total", value: { intValue: 2000 } },
		]);
		const row = parseOpencodeOtlpLogRecord(record, null, RESOURCE_JSON);
		expect(row).not.toBeNull();
		expect(row!.category).toBe("compaction");
	});
});