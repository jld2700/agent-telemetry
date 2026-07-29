/**
 * OTLP logs parser for OpenCode telemetry.
 *
 * Ported from DCC's src/daemon/routes/otel-opencode-logs.ts.
 * Discriminated by the `event.name` attribute, mirroring otel-codex-logs.ts.
 */
import type { OtlpAttribute } from './types.js';

type OpencodeOtlpLogRecord = {
  timeUnixNano?: string;
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
  if (attribute.value?.stringValue !== undefined) return attribute.value.stringValue;
  if (attribute.value?.intValue !== undefined) return String(attribute.value.intValue);
  return undefined;
}

function getStringAttr(attributes: OtlpAttribute[] | undefined, key: string): string | undefined {
  return attrValue(attributes?.find((attribute) => attribute.key === key));
}

function getIntAttr(attributes: OtlpAttribute[] | undefined, key: string): number | null {
  const value = getStringAttr(attributes, key);
  if (!value) return null;
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? null : num;
}

function attrsToJson(attributes: OtlpAttribute[] | undefined): string {
  if (!attributes || attributes.length === 0) return '{}';
  const obj: Record<string, string> = {};
  for (const attribute of attributes) {
    if (!attribute.key) continue;
    const value = attrValue(attribute);
    if (value !== undefined) obj[attribute.key] = value;
  }
  return JSON.stringify(obj);
}

function getCategory(eventName: string, hasMcpServer: boolean): string | null {
  if (eventName === 'opencode.token_usage') return 'api';
  if (eventName === 'opencode.tool_call') return hasMcpServer ? 'mcp' : 'tool';
  return null;
}

export function parseOpencodeOtlpLogRecord(
  record: OpencodeOtlpLogRecord,
  userId: string | null,
  resourceJson: string,
): OpencodeLogEventInsert | null {
  const attrs = record.attributes ?? [];
  const eventName = getStringAttr(attrs, 'event.name');
  if (!eventName) return null;

  const hasMcpServer = getStringAttr(attrs, 'mcp_server') !== undefined;
  const category = getCategory(eventName, hasMcpServer);
  if (!category) return null;

  const toolName = eventName === 'opencode.tool_call' ? (getStringAttr(attrs, 'tool_name') ?? null) : null;

  return {
    provider: 'opencode',
    category,
    event_name: eventName,
    tool_name: toolName,
    success: null,
    session_id: getStringAttr(attrs, 'session.id') ?? null,
    user_id: userId,
    attributes: attrsToJson(attrs),
    resource: resourceJson,
    duration_ms: getIntAttr(attrs, 'duration_ms'),
    timestamp_nano: record.timeUnixNano ?? null,
  };
}
