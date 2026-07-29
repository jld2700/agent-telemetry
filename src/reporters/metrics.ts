/**
 * Metrics Reporter — periodic uploader for otel_metrics to upstream URL.
 *
 * Ported from DCC's src/daemon/services/reporter-metrics.ts.
 *
 * Reads pending otel_metrics from DB (uploaded_at IS NULL), POSTs them to the
 * configured upstream URL, and marks them as uploaded.
 *
 * Metrics rows are uploaded even when session_id is null. Codex metrics
 * carry no session/conversation id at any OTLP layer — a metric datapoint is a
 * self-contained aggregate (e.g. token_usage bucketed by model), so it is
 * meaningful to report without a session. user_id is still populated when available.
 */

import type { TelemetryConfig } from '../config.js';
import {
  getPendingOtelMetrics,
  markOtelMetricsDiscarded,
  markOtelMetricsUploaded,
} from '../db/index.js';
import { logger } from '../utils/logger.js';

// Inlined constants (from DCC's src/daemon/constants.ts)
const METRICS_BATCH_SIZE = 500;
const METRICS_MAX_RETRIES = 3;
const METRICS_INITIAL_BACKOFF = 1000;
const METRICS_REQUEST_TIMEOUT_MS = 10_000;

let timer: ReturnType<typeof setInterval> | null = null;
// Re-entry guard: if a run overruns the interval (slow network + retries), skip the
// overlapping cycle instead of running two concurrent runs that could double-mark rows.
let isRunning = false;

export function startMetricsReporter(config: TelemetryConfig): void {
  if (timer) return;
  timer = setInterval(() => runMetricsReport(config), config.intervals.metrics);
  logger.info('Reporter metrics: started', { intervalMs: config.intervals.metrics });
}

export function stopMetricsReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Reporter metrics: stopped');
  }
}

export async function runMetricsReport(config: TelemetryConfig): Promise<void> {
  if (isRunning) {
    logger.warn('Reporter metrics: previous run still in progress, skipping this cycle');
    return;
  }
  isRunning = true;
  try {
    await runMetricsReportInner(config);
  } finally {
    isRunning = false;
  }
}

async function runMetricsReportInner(config: TelemetryConfig): Promise<void> {
  if (!config.upstream?.url) return;

  const baseUrl = config.upstream.url.replace(/\/+$/, '');
  const url = `${baseUrl}/v1/metrics`;

  const pending = getPendingOtelMetrics(METRICS_BATCH_SIZE);
  if (pending.length === 0) return;

  const records = pending.map((r) => ({
    id: r.id,
    provider: r.provider,
    metric_name: r.metric_name,
    metric_type: r.metric_type,
    value: r.value,
    attributes: parseAttributes(r.id as number, r.attributes as string),
    resource: parseAttributes(r.id as number, (r.resource as string) ?? '{}'),
    session_id: r.session_id,
    user_id: r.user_id,
    start_time_unix_nano: r.start_time_unix_nano,
    time_unix_nano: r.time_unix_nano,
    created_at: r.created_at,
  }));
  const ids = pending.map((r) => r.id as number);

  await uploadMetricsBatch(url, { records }, ids);
}

/** Parse the stored attributes JSON. Falls back to {} on corrupt rows so one bad record doesn't fail the batch. */
function parseAttributes(id: number, raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn('Reporter metrics: corrupt attributes JSON on record {id}: {error}, sending empty object', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

async function uploadMetricsBatch(url: string, payload: { records: unknown[] }, ids: number[]): Promise<void> {
  let backoff = METRICS_INITIAL_BACKOFF;

  for (let attempt = 1; attempt <= METRICS_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(METRICS_REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        let body: { ok: boolean; accepted: number[]; failed: number[] };
        try {
          body = (await res.json()) as { ok: boolean; accepted: number[]; failed: number[] };
        } catch (err) {
          // 200 but non-JSON body — server misbehaving. Treat as network error and retry.
          throw new Error(`unexpected response body: ${err instanceof Error ? err.message : String(err)}`);
        }
        markOtelMetricsUploaded(body.accepted);
        return;
      }

      if (res.status === 429) {
        // Rate-limited = client pacing issue, not an upstream outage.
        logger.warn('Reporter metrics: rate-limited (429), retry {attempt}/{maxRetries}', {
          attempt,
          maxRetries: METRICS_MAX_RETRIES,
        });
      } else if (res.status >= 400 && res.status < 500) {
        // Deterministic client error (e.g. 422 schema rejection). Retrying yields the same
        // result every cycle → infinite loop. Mark the whole batch discarded so it leaves
        // pending selection.
        logger.warn(
          'Reporter metrics: {status} from server, marking {count} records discarded (ids {first}-{last})',
          { status: res.status, count: ids.length, first: ids[0], last: ids[ids.length - 1] },
        );
        markOtelMetricsDiscarded(ids);
        return;
      } else {
        // 5xx = upstream outage. Non-deterministic, retry.
        logger.warn('Reporter metrics: {status} from server, retry {attempt}/{maxRetries}', {
          status: res.status,
          attempt,
          maxRetries: METRICS_MAX_RETRIES,
        });
      }
    } catch (err) {
      logger.warn('Reporter metrics: network error (attempt {attempt}/{maxRetries}): {message}', {
        attempt,
        maxRetries: METRICS_MAX_RETRIES,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (attempt < METRICS_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, backoff));
      backoff *= 2;
    }
  }

  logger.warn('Reporter metrics: all retries exhausted, batch will be retried next cycle');
}
