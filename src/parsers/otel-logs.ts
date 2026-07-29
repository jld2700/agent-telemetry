/**
 * OTLP Logs parser & persistence for Claude Code telemetry.
 *
 * Ported from DCC's src/daemon/routes/otel-logs.ts.
 *
 * Claude Code sends OTLP JSON logs to the /v1/logs endpoint.
 * This module:
 *   1. Parses the OTLP JSON payload (resourceLogs → scopeLogs → logRecords)
 *   2. Filters to allowed event types (ALLOWED_EVENTS)
 *   3. Extracts key fields (tool_name, session_id, success, duration_ms) into typed columns
 *   4. Serializes remaining attributes as flat JSON into the `attributes` column
 *   5. Inserts into SQLite `log_events` table via `insertLogEvents`
 *
 * The parse function is pure (no side effects). Persistence is done separately
 * via persistOtlpLogs().
 */

import type { LogEventInsert } from '../db/index.js';
import { insertLogEvents } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { normalizeCodexResourceAttrs, type OtlpAttribute } from './types.js';
import { parseCodexOtlpLogRecord } from './otel-codex-logs.js';
import { parseOpencodeOtlpLogRecord } from './otel-opencode-logs.js';

/**
 * Claude Code event types we persist to log_events table. Others are dropped.
 *
 * NOTE: Several attributes are gated by OTEL_LOG_TOOL_DETAILS=1:
 *   - tool_result: tool_parameters (bash_command), tool_input, file_path
 *   - skill_activated: real skill.name (otherwise "custom_skill")
 *   - mcp_server_connection: server_name
 */
const ALLOWED_EVENTS = new Set([
  // Claude Code events
  'claude_code.tool_result', // tool call completed (success/failure, duration)
  'claude_code.tool_decision', // permission decision (accept/reject + source)
  'claude_code.user_prompt', // user submitted a prompt (prompt_length, command_name)
  'claude_code.skill_activated', // skill plugin activated (skill.name, trigger)
  'claude_code.mcp_server_connection', // MCP server connect/disconnect (status, duration)
  'claude_code.api_request', // LLM API call (model, tokens, cost) — covers pure-chat sessions
  'claude_code.api_error', // LLM API call failed (error, status_code)
  'claude_code.compaction', // conversation compaction completed (trigger, pre/post_tokens)
  'claude_code.permission_mode_changed', // permission mode switch (from_mode, to_mode, trigger)
  'claude_code.hook_execution_complete', // all hooks for an event finished (hook_event, num_*, total_duration_ms)
]);

// ─── OTLP JSON type definitions ─────────────────────────────────────────────

type OtlpLogRecord = {
  timeUnixNano?: string;
  body?: { stringValue?: string };
  attributes?: OtlpAttribute[];
};

type OtlpScopeLog = {
  scope?: { name?: string; version?: string };
  logRecords?: OtlpLogRecord[];
};

type OtlpResourceLog = {
  resource?: { attributes?: OtlpAttribute[] };
  scopeLogs?: OtlpScopeLog[];
};

type OtlpLogPayload = {
  resourceLogs?: OtlpResourceLog[];
};

// ─── Attribute helpers ───────────────────────────────────────────────────────

function getStringAttr(attributes: OtlpAttribute[] | undefined, key: string): string | undefined {
  const v = attributes?.find((a) => a.key === key)?.value;
  // OTLP attrs may carry int fields as intValue (e.g. claude_code.api_request reports
  // duration_ms / status_code as intValue). Fall back so getIntAttr can parse them.
  return v?.stringValue ?? v?.intValue?.toString();
}

function truncateForLog(value: string | undefined, max = 300): string {
  if (!value) return '(empty)';
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function getIntAttr(attributes: OtlpAttribute[] | undefined, key: string): number | null {
  const v = getStringAttr(attributes, key);
  return v ? Number.parseInt(v, 10) : null;
}

/** Serialize all attributes to a flat JSON object. Handles stringValue and intValue. */
function attrsToJson(attributes: OtlpAttribute[] | undefined): string {
  if (!attributes || attributes.length === 0) return '{}';
  const obj: Record<string, string> = {};
  for (const a of attributes) {
    if (!a.key || !a.value) continue;
    // OTLP logs JSON typically uses stringValue, but some fields (e.g. status_code) use intValue
    const val = a.value.stringValue ?? a.value.intValue?.toString();
    if (val !== undefined) obj[a.key] = val;
  }
  return JSON.stringify(obj);
}

// The `resource` column mirrors the datapoint-layer `attributes` column but for
// the OTLP resource layer: we store the full resource attrs (service.name/version,
// engine.*, user.id, host.*, os.*, …) via the same attrsToJson serializer.

/**
 * Map event_name + tool_name → category.
 * Returns null for unknown events (caller should skip these).
 */
function getCategory(eventName: string, toolName: string | null): string | null {
  if (eventName === 'claude_code.skill_activated') return 'skill';
  if (eventName === 'claude_code.mcp_server_connection') return 'mcp_connection';
  if (eventName === 'claude_code.api_request' || eventName === 'claude_code.api_error') return 'api';
  if (eventName === 'claude_code.tool_decision') return 'tool_decision';
  if (eventName === 'claude_code.user_prompt') return 'user_prompt';
  if (eventName === 'claude_code.compaction') return 'compaction';
  if (eventName === 'claude_code.permission_mode_changed') return 'permission';
  if (eventName === 'claude_code.hook_execution_complete') return 'hook';
  // tool_result (and any future claude_code.tool_*) → tool/mcp by tool_name; tool_decision handled above
  if (eventName.startsWith('claude_code.tool_')) {
    return toolName === 'mcp_tool' || toolName?.startsWith('mcp__') ? 'mcp' : 'tool';
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse an OTLP logs JSON payload into rows for the log_events table.
 * Pure function — no side effects, safe to test independently.
 */
export function parseOtlpLogs(bodyText: string): LogEventInsert[] {
  const payload = JSON.parse(bodyText) as OtlpLogPayload;
  const results: LogEventInsert[] = [];

  for (const resourceLog of payload.resourceLogs ?? []) {
    // user.id is at the OTLP resource level (shared across all log records in this resource)
    const resourceAttrs = resourceLog.resource?.attributes ?? [];
    normalizeCodexResourceAttrs(resourceAttrs);
    const userId = getStringAttr(resourceAttrs, 'user.id') ?? null;
    const resourceJson = attrsToJson(resourceAttrs);

    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const codexRow = parseCodexOtlpLogRecord(record, userId, resourceJson);
        if (codexRow) {
          results.push(codexRow);
          continue;
        }

        const opencodeRow = parseOpencodeOtlpLogRecord(record, userId, resourceJson);
        if (opencodeRow) {
          results.push(opencodeRow);
          continue;
        }

        const eventName = record.body?.stringValue;
        if (!eventName || !ALLOWED_EVENTS.has(eventName)) continue;

        const attrs = record.attributes ?? [];
        // tool_name for tool events, skill.name for skill events
        const toolName = getStringAttr(attrs, 'tool_name') ?? getStringAttr(attrs, 'skill.name') ?? null;
        const category = getCategory(eventName, toolName);
        if (!category) continue;

        if (eventName === 'claude_code.api_error') {
          logger.warn(
            'Claude API error event session={session} model={model} status={status} error={error} request_id={requestId}',
            {
              session: getStringAttr(attrs, 'session.id') ?? '(missing)',
              model: getStringAttr(attrs, 'model') ?? getStringAttr(attrs, 'model_name') ?? '(unknown)',
              status: getStringAttr(attrs, 'status_code') ?? getStringAttr(attrs, 'status') ?? '(unknown)',
              error: truncateForLog(
                getStringAttr(attrs, 'error') ??
                  getStringAttr(attrs, 'error.message') ??
                  getStringAttr(attrs, 'message') ??
                  getStringAttr(attrs, 'error_type'),
              ),
              requestId: getStringAttr(attrs, 'request_id') ?? getStringAttr(attrs, 'request.id') ?? '(missing)',
            },
          );
        }

        results.push({
          provider: 'claude',
          category,
          event_name: eventName,
          tool_name: toolName,
          success: getStringAttr(attrs, 'success') ?? null,
          session_id: getStringAttr(attrs, 'session.id') ?? null,
          user_id: userId,
          attributes: attrsToJson(attrs),
          resource: resourceJson,
          duration_ms: getIntAttr(attrs, 'duration_ms'),
          timestamp_nano: record.timeUnixNano ?? null,
        });
      }
    }
  }

  return results;
}

/**
 * Parse and persist OTLP logs to SQLite.
 * Failures are logged but do not propagate (the upstream already received the data).
 */
export function persistOtlpLogs(bodyText: string): void {
  try {
    const rows = parseOtlpLogs(bodyText);
    if (rows.length > 0) {
      insertLogEvents(rows);
      logger.info('Persisted {count} log events', { count: rows.length });
    }
  } catch (err) {
    logger.warn('Failed to persist OTLP logs: {message}', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
