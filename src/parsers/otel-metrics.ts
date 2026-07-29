/**
 * OTLP Metrics parser & persistence for Claude Code & Codex telemetry.
 *
 * Ported from DCC's src/daemon/routes/otel-metrics.ts.
 *
 * Claude Code and Codex send OTLP JSON metrics to the /v1/metrics endpoint.
 * This module:
 *   1. Parses the OTLP JSON payload (resourceMetrics → scopeMetrics → metrics → dataPoints)
 *   2. Filters metrics via config-based per-agent filters (shouldCollect)
 *   3. Writes `value` type-dispatched: sum/gauge → numeric string; histogram → whole datapoint JSON
 *   4. Extracts session_id / user_id from datapoint attributes (falling back to resource)
 *   5. Stores only datapoint attributes in `attributes` (resource/scope excluded)
 *   6. Inserts into the SQLite `otel_metrics` table via `insertOtelMetrics`
 *
 * The parse function is pure (no side effects). Persistence is done separately
 * via persistOtlpMetrics().
 */

import type { OtelMetricInsert } from '../db/index.js';
import { insertOtelMetrics } from '../db/index.js';
import { logger } from '../utils/logger.js';
import type { TelemetryConfig } from '../config.js';
import { shouldCollect, inferAgentKey } from '../utils/filter.js';
import { normalizeCodexResourceAttrs, type OtlpAttribute } from './types.js';

// ─── OTLP JSON type definitions ─────────────────────────────────────────────

type OtlpDataPoint = {
  asDouble?: number;
  asInt?: number;
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  attributes?: OtlpAttribute[];
  // histogram fields
  sum?: number;
  count?: number;
  bucketCounts?: number[];
  explicitBounds?: number[];
};

type OtlpMetric = {
  name: string;
  sum?: { dataPoints?: OtlpDataPoint[] };
  gauge?: { dataPoints?: OtlpDataPoint[] };
  histogram?: { dataPoints?: OtlpDataPoint[] };
};

type OtlpScopeMetric = {
  scope?: { name?: string; version?: string };
  metrics?: OtlpMetric[];
};

type OtlpResourceMetric = {
  resource?: { attributes?: OtlpAttribute[] };
  scopeMetrics?: OtlpScopeMetric[];
};

type OtlpMetricsPayload = {
  resourceMetrics?: OtlpResourceMetric[];
};

// ─── Attribute helpers ───────────────────────────────────────────────────────

function getStringAttr(attributes: OtlpAttribute[] | undefined, key: string): string | undefined {
  return attributes?.find((a) => a.key === key)?.value?.stringValue;
}

/** Serialize datapoint attributes to a flat JSON object (stringValue + intValue). */
function attrsToJson(attributes: OtlpAttribute[] | undefined): string {
  if (!attributes || attributes.length === 0) return '{}';
  const obj: Record<string, string> = {};
  for (const a of attributes) {
    if (!a.key || !a.value) continue;
    const val = a.value.stringValue ?? a.value.intValue?.toString();
    if (val !== undefined) obj[a.key] = val;
  }
  return JSON.stringify(obj);
}

// The `resource` column mirrors the datapoint-layer `attributes` column but for
// the OTLP resource layer: we store the full resource attrs (service.name/version,
// engine.*, user.id, host.*, os.*, …) via the same attrsToJson serializer.

function inferProvider(serviceName: string | undefined, metricName: string): string {
  if (serviceName) {
    if (serviceName.includes('claude')) return 'claude_code';
    if (serviceName.includes('codex')) return 'codex';
  }
  if (metricName.startsWith('claude_code.')) return 'claude_code';
  if (metricName.startsWith('codex.')) return 'codex';
  return 'unknown';
}

/** Numeric value of a sum/gauge datapoint as a string, or null if neither present. */
function datapointNumber(dp: OtlpDataPoint): string | null {
  if (typeof dp.asDouble === 'number') return String(dp.asDouble);
  if (typeof dp.asInt === 'number') return String(dp.asInt);
  return null;
}

function buildRow(
  dp: OtlpDataPoint,
  metricName: string,
  metricType: string,
  serviceName: string | undefined,
  resourceUserId: string | null,
  resourceJson: string,
): OtelMetricInsert {
  const dpAttrs = dp.attributes ?? [];
  const sessionId = getStringAttr(dpAttrs, 'session.id') ?? null;
  // user_id only from OTLP resource layer (resourceUserId already includes credentials fallback).
  // Don't read datapoint-layer user.id — claude-code puts an anonymous hash there, which would
  // overwrite the real username. Aligned with log_events (otel-logs.ts).
  const userId = resourceUserId;

  // value: sum/gauge → numeric string; histogram → whole datapoint JSON
  let value: string | null;
  if (metricType === 'histogram') {
    value = JSON.stringify(dp as Record<string, unknown>);
  } else {
    value = datapointNumber(dp);
  }

  return {
    provider: inferProvider(serviceName, metricName),
    metric_name: metricName,
    metric_type: metricType,
    value,
    attributes: attrsToJson(dpAttrs),
    resource: resourceJson,
    session_id: sessionId,
    user_id: userId,
    start_time_unix_nano: dp.startTimeUnixNano ?? null,
    time_unix_nano: dp.timeUnixNano ?? null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse an OTLP metrics JSON payload into rows for the otel_metrics table.
 * Pure function — no side effects. Returns [] for malformed input (does not throw).
 *
 * @param bodyText  Raw OTLP JSON string
 * @param config    Telemetry config (used for per-agent metric filtering)
 */
export function parseOtlpMetrics(bodyText: string, config?: TelemetryConfig): OtelMetricInsert[] {
  let payload: OtlpMetricsPayload;
  try {
    payload = JSON.parse(bodyText) as OtlpMetricsPayload;
  } catch {
    return [];
  }
  if (!payload || !Array.isArray(payload.resourceMetrics)) return [];

  const results: OtelMetricInsert[] = [];
  const agentsConfig = config?.agents ?? {};

  for (const resourceMetric of payload.resourceMetrics) {
    const resourceAttrs = resourceMetric.resource?.attributes ?? [];
    normalizeCodexResourceAttrs(resourceAttrs);
    const serviceName = getStringAttr(resourceAttrs, 'service.name');
    const resourceUserId = getStringAttr(resourceAttrs, 'user.id') ?? null;
    const resourceJson = attrsToJson(resourceAttrs);

    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        // Config-based filtering: check if this metric should be collected
        const agentKey = inferAgentKey(metric.name);
        if (!shouldCollect(metric.name, agentKey, 'metrics', agentsConfig)) continue;

        if (metric.sum?.dataPoints) {
          for (const dp of metric.sum.dataPoints) {
            results.push(buildRow(dp, metric.name, 'sum', serviceName, resourceUserId, resourceJson));
          }
        }
        if (metric.gauge?.dataPoints) {
          for (const dp of metric.gauge.dataPoints) {
            results.push(buildRow(dp, metric.name, 'gauge', serviceName, resourceUserId, resourceJson));
          }
        }
        if (metric.histogram?.dataPoints) {
          for (const dp of metric.histogram.dataPoints) {
            results.push(buildRow(dp, metric.name, 'histogram', serviceName, resourceUserId, resourceJson));
          }
        }
      }
    }
  }

  return results;
}

/**
 * Parse and persist OTLP metrics to SQLite.
 * Failures are logged but do not propagate.
 */
export function persistOtlpMetrics(bodyText: string, config?: TelemetryConfig): void {
  try {
    const rows = parseOtlpMetrics(bodyText, config);
    if (rows.length > 0) {
      insertOtelMetrics(rows);
      logger.info('Persisted {count} metric datapoints', { count: rows.length });
    }
  } catch (err) {
    logger.warn('Failed to persist OTLP metrics: {message}', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
