/**
 * OTLP logs parser for OpenCode telemetry.
 *
 * OpenCode natively sends OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Its logs are Effect framework structured logs:
 *   - body.stringValue = message text (e.g. "stream", "command", "created")
 *   - attributes = structured fields (e.g. session.id, providerID, modelID, agent, mode)
 *   - NO event.name attribute (unlike Codex)
 *   - resource.attributes has service.name = "opencode"
 *
 * The event_name is constructed as `opencode.` + body.stringValue.
 * If body.stringValue is missing, the record is skipped.
 */
import type { TelemetryConfig } from "../config.js";
import { shouldCollect } from "../utils/filter.js";
import type { OtlpAttribute } from "./types.js";

type OpencodeOtlpLogRecord = {
	timeUnixNano?: string;
	body?: { stringValue?: string } | null;
	attributes?: OtlpAttribute[];
};

export type OpencodeLogEventInsert = {
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

function attrValue(attribute: OtlpAttribute | undefined): string | undefined {
	if (!attribute) return undefined;
	if (attribute.value?.stringValue !== undefined)
		return attribute.value.stringValue;
	if (attribute.value?.intValue !== undefined)
		return String(attribute.value.intValue);
	return undefined;
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
	if (!value) return null;
	const num = Number.parseInt(value, 10);
	return Number.isNaN(num) ? null : num;
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

/**
 * Map OpenCode message text → category.
 * Returns null for messages that should be dropped entirely.
 */
function getCategory(message: string): string | null {
	// LLM/API events
	if (
		message === "stream" ||
		message === "llm runtime selected" ||
		message === "native runtime unavailable; falling back to ai-sdk"
	) {
		return "api";
	}

	// User interaction
	if (message === "command") return "user_prompt";

	// Session lifecycle
	if (
		[
			"created",
			"loop",
			"cancel",
			"unreverting",
			"exiting loop",
			"session.id",
		].includes(message)
	) {
		return "session";
	}

	// Compaction
	if (
		["pruned", "pruning", "tail fallback", "found", "prune"].includes(message)
	) {
		return "compaction";
	}

	// MCP
	if (message === "mcp resource") return "mcp";

	// Errors (message starts with "failed" or "invalid", or known error messages)
	if (
		message.startsWith("failed") ||
		message.startsWith("invalid") ||
		message === "stream error" ||
		message === "process"
	) {
		return "error";
	}

	// File operations
	if (["file", "find file", "resolved path"].includes(message)) return "tool";

	// Sync/connection events
	if (
		message.includes("sync") ||
		message.includes("connected") ||
		message.includes("disconnected") ||
		message.includes("disposal")
	) {
		return "other";
	}

	// Shell
	if (message === "shell tool using shell") return "tool";

	// Everything else
	return "other";
}

export function parseOpencodeOtlpLogRecord(
	record: OpencodeOtlpLogRecord,
	userId: string | null,
	resourceJson: string,
	config?: TelemetryConfig,
): OpencodeLogEventInsert | null {
	// Only process records from OpenCode (service.name = "opencode" in resource)
	// This prevents swallowing Claude Code or Codex events that also have body.stringValue.
	try {
		const resource = JSON.parse(resourceJson) as Record<string, unknown>;
		if (resource["service.name"] !== "opencode") return null;
	} catch {
		return null;
	}

	const message = record.body?.stringValue;
	if (!message) return null;

	// Construct event_name: opencode.<message>
	const eventName = `opencode.${message}`;

	// Config-based filtering: check if this event should be collected
	const agentsConfig = config?.agents ?? {};
	if (!shouldCollect(eventName, "opencode", "log_events", agentsConfig))
		return null;

	const attrs = record.attributes ?? [];
	const category = getCategory(message);
	if (!category) return null;

	const toolName =
		getStringAttr(attrs, "tool.name") ??
		getStringAttr(attrs, "tool_name") ??
		null;

	return {
		provider: "opencode",
		category,
		event_name: eventName,
		tool_name: toolName,
		success: null, // OpenCode logs don't have a success field
		session_id: getStringAttr(attrs, "session.id") ?? null,
		user_id: userId,
		attributes: attrsToJson(attrs),
		resource: resourceJson,
		duration_ms:
			getIntAttr(attrs, "duration_ms") ?? getIntAttr(attrs, "duration"),
		timestamp_nano: record.timeUnixNano ?? null,
	};
}
