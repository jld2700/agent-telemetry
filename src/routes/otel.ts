/**
 * OTLP HTTP route handler.
 *
 * Ported from DCC's src/daemon/routes/otel.ts.
 *
 * Receives OTLP POST requests at /v1/{logs,metrics,traces}, parses them,
 * persists to local SQLite (with config-based filtering), and optionally
 * forwards raw OTLP bodies to one or more generic OTLP/HTTP forwarders
 * (Langfuse, Honeycomb, Datadog, Jaeger, Grafana Cloud, etc.).
 *
 * Logs and metrics are persisted locally and optionally forwarded.
 * Traces are forwarded when a forwarder with 'traces' in its signals is configured.
 */

import type { AuthConfig, OtlpForwarder, TelemetryConfig } from "../config.js";
import { persistOtlpLogs } from "../parsers/otel-logs.js";
import { persistOtlpMetrics } from "../parsers/otel-metrics.js";
import { logger } from "../utils/logger.js";

const PROXY_TIMEOUT_MS = 30_000;
const ALLOWED_SUBPATHS = new Set(["/v1/traces", "/v1/metrics", "/v1/logs"]);
const ALLOWED_METHODS = new Set(["POST"]);
const MAX_INFLIGHT_REQUESTS = 128;
const MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024; // 10MB

const inFlightRequests = 0;

function jsonError(
	status: number,
	type: string,
	message: string,
	headers?: Record<string, string>,
	extras?: Record<string, unknown>,
): Response {
	return new Response(
		JSON.stringify({ error: { message, type, ...(extras ?? {}) } }),
		{
			status,
			headers: { "content-type": "application/json", ...(headers ?? {}) },
		},
	);
}

// ─── Generic OTLP forwarding ────────────────────────────────────────────────

type SignalType = "traces" | "logs" | "metrics";

/**
 * Build the Authorization header (and any custom headers) based on the forwarder's auth config.
 */
function buildForwarderHeaders(
	auth: AuthConfig,
	contentType: string,
	contentEncoding: string | null,
): Headers {
	const headers = new Headers();
	headers.set("Content-Type", contentType);

	switch (auth.type) {
		case "basic": {
			const username = auth.username ?? "";
			const password = auth.password ?? "";
			headers.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`);
			break;
		}
		case "bearer":
			if (auth.token) {
				headers.set("Authorization", `Bearer ${auth.token}`);
			}
			break;
		case "header":
			if (auth.headers) {
				for (const [key, value] of Object.entries(auth.headers)) {
					headers.set(key, value);
				}
			}
			break;
		default:
			// No auth header
			break;
	}

	if (contentEncoding) {
		headers.set("Content-Encoding", contentEncoding);
	}

	return headers;
}

/**
 * Forward a raw OTLP body to all enabled forwarders that accept the given signal type.
 * Fire-and-forget — does not block the response to the agent. Errors are logged.
 */
function forwardOtlp(
	signalType: SignalType,
	bodyText: string,
	config: TelemetryConfig,
): void {
	const forwarders = config.otlp_forwarders.filter(
		(f) => f.enabled && f.signals.includes(signalType),
	);

	if (forwarders.length === 0) return;

	const contentEncoding = null; // bodyText is already decoded text
	const contentType = "application/json; charset=utf-8";

	for (const forwarder of forwarders) {
		// Fire-and-forget: don't await, don't block
		void forwardToOne(
			forwarder,
			signalType,
			bodyText,
			buildForwarderHeaders(forwarder.auth, contentType, contentEncoding),
		);
	}
}

async function forwardToOne(
	forwarder: OtlpForwarder,
	signalType: SignalType,
	bodyText: string,
	headers: Headers,
): Promise<void> {
	const url = forwarder.url;
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers,
			body: bodyText,
			signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
		});

		if (!resp.ok) {
			let upstreamMessage = `OTLP forwarder "${forwarder.name}" returned ${resp.status}`;
			try {
				const ct = resp.headers.get("content-type") ?? "";
				if (ct.includes("application/json")) {
					const json = (await resp.json()) as {
						error?: { message?: string };
						message?: string;
					};
					upstreamMessage =
						json.error?.message ?? json.message ?? upstreamMessage;
				} else {
					const text = (await resp.text()).trim();
					if (text) upstreamMessage = text.slice(0, 500);
				}
			} catch {
				// Ignore parse failure
			}
			logger.warn('OTLP forward "{name}" error: {status} {message}', {
				name: forwarder.name,
				signal: signalType,
				url,
				status: resp.status,
				message: upstreamMessage,
			});
		} else {
			logger.debug('OTLP forward "{name}" OK ({signal})', {
				name: forwarder.name,
				signal: signalType,
				status: resp.status,
			});
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message.includes("timeout") || message.includes("timed out")) {
			logger.warn('OTLP forward "{name}" timeout after {timeoutMs}ms', {
				name: forwarder.name,
				signal: signalType,
				timeoutMs: PROXY_TIMEOUT_MS,
			});
		} else {
			logger.warn('OTLP forward "{name}" error: {message}', {
				name: forwarder.name,
				signal: signalType,
				message,
			});
		}
	}
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * Handle OTLP requests from Claude Code / Codex / OpenCode.
 *
 * Agents send OTLP telemetry to `http://127.0.0.1:{port}/v1/{signal}`.
 * - /v1/logs: parsed & persisted locally (config-filtered), optionally forwarded
 * - /v1/metrics: parsed & persisted locally (config-filtered), optionally forwarded
 * - /v1/traces: optionally forwarded to OTLP forwarders that accept traces
 *
 * Returns 200 immediately (forwarders are fire-and-forget).
 */
export async function handleOtelProxy(
	req: Request,
	config: TelemetryConfig,
): Promise<Response> {
	const url = new URL(req.url);
	// Accept both /api/otel/v1/{signal} (standard, what Claude Code sends)
	// and /v1/{signal} (bare path) by stripping the /api/otel prefix if present.
	const subPath = url.pathname.replace(/^\/api\/otel/, "");

	if (!ALLOWED_METHODS.has(req.method)) {
		return jsonError(
			405,
			"method_not_allowed",
			`Method ${req.method} not allowed`,
			{ Allow: "POST" },
		);
	}

	if (!ALLOWED_SUBPATHS.has(subPath)) {
		return jsonError(404, "not_found", "Unknown OTEL path");
	}

	const rawContentLength = req.headers.get("content-length");
	if (rawContentLength) {
		const contentLength = Number(rawContentLength);
		if (!Number.isFinite(contentLength) || contentLength < 0) {
			return jsonError(
				400,
				"invalid_content_length",
				"Invalid Content-Length header",
			);
		}
		if (contentLength > MAX_CONTENT_LENGTH_BYTES) {
			return jsonError(
				413,
				"payload_too_large",
				"OTLP payload exceeds 10MB limit",
				undefined,
				{
					limit_bytes: MAX_CONTENT_LENGTH_BYTES,
				},
			);
		}
	}

	if (inFlightRequests >= MAX_INFLIGHT_REQUESTS) {
		return jsonError(
			429,
			"too_many_requests",
			"OTLP proxy is overloaded, retry later",
		);
	}

	// Read body once (if not compressed)
	let bodyText = "";
	const isCompressed = !!req.headers.get("content-encoding");
	if (!isCompressed) {
		bodyText = req.body ? await req.text() : "";
	}

	// Determine signal type from sub-path
	const signalType: SignalType | null =
		subPath === "/v1/logs"
			? "logs"
			: subPath === "/v1/metrics"
				? "metrics"
				: subPath === "/v1/traces"
					? "traces"
					: null;

	if (!signalType) {
		return jsonError(404, "not_found", "Unknown OTEL path");
	}

	// ── Local persistence (config-filtered) ──────────────────────────────────

	if (!isCompressed) {
		if (signalType === "logs" && config.collect_logs) {
			queueMicrotask(() => persistOtlpLogs(bodyText, config));
		}
		if (signalType === "metrics" && config.collect_metrics) {
			queueMicrotask(() => persistOtlpMetrics(bodyText, config));
		}
		// Traces are not persisted locally (no traces table), only forwarded.
	}

	// ── OTLP forwarding (fire-and-forget) ────────────────────────────────────

	if (!isCompressed) {
		// Forward the raw OTLP body to all matching forwarders
		forwardOtlp(signalType, bodyText, config);
	}

	// Return 200 immediately — forwarding is fire-and-forget
	return new Response(null, { status: 200 });
}

// ─── Server startup ──────────────────────────────────────────────────────────

/**
 * Start the OTLP HTTP server. Returns the Bun server instance.
 */
export function startOtlpServer(config: TelemetryConfig) {
	const server = Bun.serve({
		port: config.server.port,
		hostname: config.server.host,
		async fetch(req) {
			return handleOtelProxy(req, config);
		},
	});

	logger.info("OTLP server listening", {
		host: config.server.host,
		port: config.server.port,
	});

	// Log forwarder configuration
	if (config.otlp_forwarders.length > 0) {
		const enabled = config.otlp_forwarders.filter((f) => f.enabled);
		if (enabled.length > 0) {
			logger.info("OTLP forwarders active", {
				count: enabled.length,
				names: enabled.map((f) => `${f.name}[${f.signals.join(",")}]`),
			});
		}
	}

	return server;
}
