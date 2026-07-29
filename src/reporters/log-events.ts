/**
 * Log Events Reporter — periodic uploader for log_events to upstream URL.
 *
 * Ported from DCC's src/daemon/services/reporter-log-events.ts.
 *
 * Reads pending log_events from DB (uploaded_at IS NULL), POSTs them to the
 * configured upstream URL, and marks them as uploaded.
 *
 * Key difference from DCC: removes the `session_id !== null` filter —
 * agent-telemetry uploads ALL log events, not just ones with session_id.
 */

import type { TelemetryConfig } from "../config.js";
import {
	getPendingLogEvents,
	markLogEventsDiscarded,
	markLogEventsUploaded,
} from "../db/index.js";
import { logger } from "../utils/logger.js";

const LOG_EVENTS_MAX_RETRIES = 3;
const LOG_EVENTS_INITIAL_BACKOFF = 1000;
const LOG_EVENTS_REQUEST_TIMEOUT_MS = 10_000;

let timer: ReturnType<typeof setInterval> | null = null;
// Re-entry guard: if a run overruns the interval (slow network + retries), skip the
// overlapping cycle instead of running two concurrent runs that could double-mark rows.
let isRunning = false;

export function startLogEventsReporter(config: TelemetryConfig): void {
	if (timer) return;
	if (!config.upstream?.url || !config.upstream.report_logs) {
		logger.info(
			"Reporter log-events: disabled (no upstream URL or report_logs=false)",
		);
		return;
	}

	const intervalMs = config.upstream.interval_ms;
	timer = setInterval(() => runLogEventsReport(config), intervalMs);
	logger.info("Reporter log-events: started", { intervalMs });
}

export function stopLogEventsReporter(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
		logger.info("Reporter log-events: stopped");
	}
}

export async function runLogEventsReport(
	config: TelemetryConfig,
): Promise<void> {
	if (isRunning) {
		logger.warn(
			"Reporter log-events: previous run still in progress, skipping this cycle",
		);
		return;
	}
	isRunning = true;
	try {
		await runLogEventsReportInner(config);
	} finally {
		isRunning = false;
	}
}

async function runLogEventsReportInner(config: TelemetryConfig): Promise<void> {
	if (!config.upstream?.url || !config.upstream.report_logs) return;

	const baseUrl = config.upstream.url.replace(/\/+$/, "");
	const url = `${baseUrl}/v1/logs`;
	const batchSize = config.upstream.batch_size;

	const pending = getPendingLogEvents(batchSize);
	// IMPORTANT: Unlike DCC, agent-telemetry uploads ALL log events (no session_id filter).
	// DCC filtered to session_id !== null because its dashboard required session attribution;
	// agent-telemetry is a standalone collector that should upload everything.
	if (pending.length === 0) return;

	const records = pending.map((r) => ({
		id: r.id,
		provider: r.provider,
		category: r.category,
		event_name: r.event_name,
		tool_name: r.tool_name,
		success: (r.success as string | null) ?? "unknown",
		session_id: r.session_id,
		user_id: r.user_id,
		attributes: parseAttributes(r.id as number, r.attributes as string),
		resource: parseAttributes(r.id as number, (r.resource as string) ?? "{}"),
		duration_ms: r.duration_ms,
		timestamp_nano: r.timestamp_nano,
		created_at: r.created_at,
	}));
	const ids = pending.map((r) => r.id as number);

	await uploadLogEventsBatch(url, { records }, ids, config.upstream.token);
}

/** Parse the stored attributes JSON. Falls back to {} on corrupt rows so one bad record doesn't fail the batch. */
function parseAttributes(id: number, raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		logger.warn(
			"Reporter log-events: corrupt attributes JSON on record {id}: {error}, sending empty object",
			{
				id,
				error: err instanceof Error ? err.message : String(err),
			},
		);
		return {};
	}
}

async function uploadLogEventsBatch(
	url: string,
	payload: { records: unknown[] },
	ids: number[],
	authToken?: string,
): Promise<void> {
	let backoff = LOG_EVENTS_INITIAL_BACKOFF;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (authToken) {
		headers.Authorization = `Bearer ${authToken}`;
	}

	for (let attempt = 1; attempt <= LOG_EVENTS_MAX_RETRIES; attempt++) {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(LOG_EVENTS_REQUEST_TIMEOUT_MS),
			});

			if (res.ok) {
				let body: { ok: boolean; accepted: number[]; failed: number[] };
				try {
					body = (await res.json()) as {
						ok: boolean;
						accepted: number[];
						failed: number[];
					};
				} catch (err) {
					// 200 but non-JSON body — server misbehaving. Treat as network error and retry.
					throw new Error(
						`unexpected response body: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				markLogEventsUploaded(body.accepted);
				return;
			}

			if (res.status === 429) {
				// Rate-limited = client pacing issue, not an upstream outage.
				logger.warn(
					"Reporter log-events: rate-limited (429), retry {attempt}/{maxRetries}",
					{
						attempt,
						maxRetries: LOG_EVENTS_MAX_RETRIES,
					},
				);
			} else if (res.status >= 400 && res.status < 500) {
				// Deterministic client error (e.g. 422 schema rejection). Retrying yields the same
				// result every cycle → infinite loop. Mark the whole batch discarded so it leaves
				// pending selection. Discarded rows are queryable via the sentinel uploaded_at value.
				logger.warn(
					"Reporter log-events: {status} from server, marking {count} records discarded (ids {first}-{last})",
					{
						status: res.status,
						count: ids.length,
						first: ids[0],
						last: ids[ids.length - 1],
					},
				);
				markLogEventsDiscarded(ids);
				return;
			} else {
				// 5xx = upstream outage. Non-deterministic, retry.
				logger.warn(
					"Reporter log-events: {status} from server, retry {attempt}/{maxRetries}",
					{
						status: res.status,
						attempt,
						maxRetries: LOG_EVENTS_MAX_RETRIES,
					},
				);
			}
		} catch (err) {
			logger.warn(
				"Reporter log-events: network error (attempt {attempt}/{maxRetries}): {message}",
				{
					attempt,
					maxRetries: LOG_EVENTS_MAX_RETRIES,
					message: err instanceof Error ? err.message : String(err),
				},
			);
		}

		if (attempt < LOG_EVENTS_MAX_RETRIES) {
			await new Promise((r) => setTimeout(r, backoff));
			backoff *= 2;
		}
	}

	logger.warn(
		"Reporter log-events: all retries exhausted, batch will be retried next cycle",
	);
}
