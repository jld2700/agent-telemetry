/**
 * OTLP Logs parser for Codex telemetry.
 *
 * Ported from DCC's src/daemon/routes/otel-codex-logs.ts.
 * Discriminated by the `event.name` attribute.
 */
import type { TelemetryConfig } from "../config.js";
import { inferAgentKey, shouldCollect } from "../utils/filter.js";
import type { OtlpAttribute } from "./types.js";

type CodexOtlpLogRecord = {
	timeUnixNano?: string;
	body?: { stringValue?: string } | null;
	attributes?: OtlpAttribute[];
};

export type CodexLogEventInsert = {
	provider: string;
	category: string;
	event_name: string;
	tool_name: string | null;
	success: string | null;
	session_id: string | null;
	user_id: string | null;
	attributes: string;
	resource: string;
	duration_ms: number | null;
	timestamp_nano: string | null;
};

const API_EVENTS = new Set(["codex.api_request", "codex.websocket_request"]);

function attrValue(attribute: OtlpAttribute | undefined): string | undefined {
	return (
		attribute?.value?.stringValue ?? attribute?.value?.intValue?.toString()
	);
}

function getStringAttr(
	attributes: OtlpAttribute[] | undefined,
	key: string,
): string | undefined {
	return attrValue(attributes?.find((attribute) => attribute.key === key));
}

function getIntAttr(
	attributes: OtlpAttribute[] | undefined,
	key: string,
): number | null {
	const value = getStringAttr(attributes, key);
	return value ? Number.parseInt(value, 10) : null;
}

function attrsToJson(attributes: OtlpAttribute[] | undefined): string {
	if (!attributes || attributes.length === 0) return "{}";
	const obj: Record<string, string> = {};
	for (const attribute of attributes) {
		if (!attribute.key) continue;
		const value = attrValue(attribute);
		if (value !== undefined) obj[attribute.key] = value;
	}
	return JSON.stringify(obj);
}

function getCategory(
	eventName: string,
	toolName: string | null,
	eventKind: string | undefined,
): string | null {
	if (eventName === "codex.conversation_starts") return "conversation_starts";
	if (eventName === "codex.user_prompt") return "user_prompt";
	// sse_event is codex token statistics source. Only response.completed carries token counts
	// (input/cached token_count); other event.kind (message/response.delta, etc., 99.7%) are
	// pure noise, dropped at ingest. response.completed gets independent category 'sse'.
	if (eventName === "codex.sse_event")
		return eventKind === "response.completed" ? "sse" : null;
	if (API_EVENTS.has(eventName)) return "api";
	if (eventName === "codex.tool_result") {
		return toolName === "mcp_tool" || toolName?.startsWith("mcp__")
			? "mcp"
			: "tool";
	}
	return null;
}

function toNano(isoOrNano: string | undefined): string | null {
	if (!isoOrNano || isoOrNano === "0") return null;
	if (/^\d+$/.test(isoOrNano)) return isoOrNano;
	const ms = Date.parse(isoOrNano);
	return Number.isNaN(ms) ? null : String(ms * 1_000_000);
}

export function parseCodexOtlpLogRecord(
	record: CodexOtlpLogRecord,
	userId: string | null,
	resourceJson: string,
	config?: TelemetryConfig,
): CodexLogEventInsert | null {
	const attrs = record.attributes ?? [];
	const eventName = getStringAttr(attrs, "event.name");
	if (!eventName) return null;

	// Config-based filtering: check if this event should be collected
	const agentsConfig = config?.agents ?? {};
	if (
		!shouldCollect(
			eventName,
			inferAgentKey(eventName),
			"log_events",
			agentsConfig,
		)
	)
		return null;

	const toolName = getStringAttr(attrs, "tool_name") ?? null;
	const eventKind = getStringAttr(attrs, "event.kind");
	const category = getCategory(eventName, toolName, eventKind);
	if (!category) return null;

	const timestampNano =
		toNano(record.timeUnixNano) ??
		toNano(getStringAttr(attrs, "event.timestamp"));

	return {
		provider: "codex",
		category,
		event_name: eventName,
		tool_name: toolName,
		success: getStringAttr(attrs, "success") ?? null,
		session_id: getStringAttr(attrs, "conversation.id") ?? null,
		user_id: userId,
		attributes: attrsToJson(attrs),
		resource: resourceJson,
		duration_ms: getIntAttr(attrs, "duration_ms"),
		timestamp_nano: timestampNano,
	};
}
