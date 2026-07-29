import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LogEventInsert,
	closeDb,
	getDb,
	getPendingLogEvents,
	getPendingOtelMetrics,
	initDb,
	insertLogEvents,
	insertOtelMetrics,
	markLogEventsUploaded,
} from "../../src/db/index.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "agent-telemetry-test-"));
	initDb(tempDir);
});

afterEach(() => {
	closeDb();
	rmSync(tempDir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<LogEventInsert> = {}): LogEventInsert {
	return {
		provider: "claude",
		category: "tool",
		event_name: "claude_code.tool_result",
		tool_name: "Bash",
		success: "true",
		session_id: "test-session-1",
		user_id: null,
		attributes: '{"tool_name":"Bash"}',
		resource: "{}",
		duration_ms: null,
		timestamp_nano: "1737500000000000000",
		...overrides,
	};
}

describe("initDb", () => {
	test("creates log_events table", () => {
		insertLogEvents([makeRow()]);
		const rows = getPendingLogEvents(100);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].provider).toBe("claude");
	});

	test("creates otel_metrics table", () => {
		insertOtelMetrics([
			{
				provider: "claude",
				metric_name: "claude_code.tokens_used",
				metric_type: "counter",
				value: "100",
				attributes: "{}",
				session_id: "s1",
				user_id: null,
				start_time_unix_nano: null,
				time_unix_nano: "1737500000000000000",
			},
		]);
		const rows = getPendingOtelMetrics(100);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].metric_name).toBe("claude_code.tokens_used");
	});

	test("creates telemetry_events table", () => {
		const db = getDb();
		db.exec(
			"INSERT INTO telemetry_events (event, payload) VALUES ('test_event', '{\"key\":\"value\"}')",
		);
		const rows = db.query("SELECT * FROM telemetry_events").all() as Array<
			Record<string, unknown>
		>;
		expect(rows.length).toBe(1);
		expect(rows[0].event).toBe("test_event");
	});
});

describe("insertLogEvents", () => {
	test("inserts rows correctly", () => {
		insertLogEvents([
			makeRow({
				event_name: "claude_code.tool_result",
				session_id: "session-a",
			}),
			makeRow({
				event_name: "claude_code.api_request",
				session_id: "session-b",
			}),
		]);
		const rows = getPendingLogEvents(100);
		expect(rows).toHaveLength(2);
		expect(rows[0].event_name).toBe("claude_code.tool_result");
		expect(rows[1].event_name).toBe("claude_code.api_request");
	});

	test("empty array is a no-op", () => {
		insertLogEvents([]);
		const rows = getPendingLogEvents(100);
		expect(rows).toHaveLength(0);
	});
});

describe("getPendingLogEvents", () => {
	test("returns rows where uploaded_at IS NULL", () => {
		insertLogEvents([
			makeRow({ session_id: "s1" }),
			makeRow({ session_id: "s2" }),
		]);
		const rows = getPendingLogEvents(100);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.uploaded_at).toBeNull();
		}
	});

	test("respects limit parameter", () => {
		insertLogEvents([
			makeRow({ session_id: "s1" }),
			makeRow({ session_id: "s2" }),
			makeRow({ session_id: "s3" }),
		]);
		const rows = getPendingLogEvents(2);
		expect(rows).toHaveLength(2);
	});

	test("returns empty after all marked uploaded", () => {
		insertLogEvents([
			makeRow({ session_id: "s1" }),
			makeRow({ session_id: "s2" }),
		]);
		const pending = getPendingLogEvents(100);
		const ids = pending.map((r) => r.id as number);
		markLogEventsUploaded(ids);
		const remaining = getPendingLogEvents(100);
		expect(remaining).toHaveLength(0);
	});
});

describe("markLogEventsUploaded", () => {
	test("sets uploaded_at timestamp", () => {
		insertLogEvents([makeRow({ session_id: "s1" })]);
		const pending = getPendingLogEvents(100);
		const id = pending[0].id as number;
		markLogEventsUploaded([id]);
		const row = getDb()
			.query("SELECT * FROM log_events WHERE id = ?")
			.get(id) as Record<string, unknown>;
		expect(row.uploaded_at).not.toBeNull();
	});

	test("empty array is a no-op", () => {
		expect(() => markLogEventsUploaded([])).not.toThrow();
	});
});
