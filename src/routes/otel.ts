/**
 * OTLP HTTP route handler.
 *
 * Ported from DCC's src/daemon/routes/otel.ts.
 *
 * Receives OTLP POST requests at /v1/{logs,metrics,traces}, parses them,
 * persists to local SQLite, and optionally forwards traces to Langfuse.
 *
 * Logs and metrics are persisted locally only (not forwarded to Langfuse).
 * Traces are forwarded to Langfuse when configured.
 */

import type { TelemetryConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { persistOtlpLogs } from '../parsers/otel-logs.js';
import { persistOtlpMetrics } from '../parsers/otel-metrics.js';
import type { OtlpAttribute } from '../parsers/types.js';

const PROXY_TIMEOUT_MS = 30_000;
const ALLOWED_SUBPATHS = new Set(['/v1/traces', '/v1/metrics', '/v1/logs']);
const ALLOWED_METHODS = new Set(['POST']);
const MAX_INFLIGHT_REQUESTS = 128;
const MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024; // 10MB

let inFlightRequests = 0;

function jsonError(
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>,
  extras?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({ error: { message, type, ...(extras ?? {}) } }), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return true;
  }
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    return message.includes('timeout') || message.includes('timed out');
  }
  return false;
}

// ─── Trace patching (Langfuse forwarding) ────────────────────────────────────

type OtlpSpan = {
  attributes?: OtlpAttribute[];
};

type OtlpScopeSpan = {
  scope?: {
    name?: string;
    version?: string;
  };
  spans?: OtlpSpan[];
};

type OtlpResource = {
  attributes?: OtlpAttribute[];
};

type OtlpResourceSpan = {
  resource?: OtlpResource;
  scopeSpans?: OtlpScopeSpan[];
};

type OtlpTracePayload = {
  resourceSpans?: OtlpResourceSpan[];
};

function shouldPatchTraceJson(subPath: string, headers: Headers): boolean {
  if (subPath !== '/v1/traces') {
    return false;
  }

  const contentType = headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return false;
  }

  return !headers.get('content-encoding');
}

function getStringAttribute(attributes: OtlpAttribute[] | undefined, key: string): string | undefined {
  return attributes?.find((attribute) => attribute.key === key)?.value?.stringValue;
}

function upsertStringAttribute(attributes: OtlpAttribute[], key: string, value: string): void {
  const existing = attributes.find((attribute) => attribute.key === key);
  if (existing) {
    existing.value = { stringValue: value };
    return;
  }

  attributes.push({ key, value: { stringValue: value } });
}

const KNOWN_SERVICE_NAMES = ['claude_code', 'codex'] as const;

function normalizeServiceName(scopeName: string): string {
  // "com.anthropic.claude_code.events" → "claude_code"
  // "codex" → "codex"
  for (const name of KNOWN_SERVICE_NAMES) {
    if (scopeName.includes(name)) return name;
  }
  return scopeName;
}

function buildLangfuseTraceTags(sourceServiceName: string, sourceServiceVersion: string): string {
  const name = normalizeServiceName(sourceServiceName);
  return JSON.stringify([`${name}@${sourceServiceVersion}`, name]);
}

function patchOtelTraceJson(bodyText: string, serviceName: string, serviceVersion: string): string {
  const payload = JSON.parse(bodyText) as OtlpTracePayload;

  for (const resourceSpan of payload.resourceSpans ?? []) {
    const resourceAttributes = resourceSpan.resource?.attributes ?? [];
    const userId = getStringAttribute(resourceAttributes, 'user.id');

    if (!userId) {
      continue;
    }

    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      scopeSpan.scope = scopeSpan.scope ?? {};
      const sourceScopeName = scopeSpan.scope?.name || 'claude_code';
      const sourceScopeVersion = scopeSpan.scope?.version || serviceVersion;
      const langfuseTraceTags = buildLangfuseTraceTags(sourceScopeName, sourceScopeVersion);

      scopeSpan.scope.name = serviceName;
      scopeSpan.scope.version = serviceVersion;

      for (const span of scopeSpan.spans ?? []) {
        const attributes = span.attributes ?? [];
        span.attributes = attributes;

        if (userId) {
          upsertStringAttribute(attributes, 'user.id', userId);
        }

        upsertStringAttribute(attributes, 'langfuse.trace.tags', langfuseTraceTags);
      }
    }
  }

  return JSON.stringify(payload);
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * Handle OTLP requests from Claude Code / Codex / OpenCode.
 *
 * Agents send OTLP telemetry to `http://127.0.0.1:{port}/v1/{signal}`.
 * - /v1/logs: persisted locally, returns 200
 * - /v1/metrics: persisted locally, returns 200
 * - /v1/traces: forwarded to Langfuse (when configured), with trace JSON patched
 */
export async function handleOtelProxy(req: Request, config: TelemetryConfig): Promise<Response> {
  const url = new URL(req.url);
  const subPath = url.pathname;

  if (!ALLOWED_METHODS.has(req.method)) {
    return jsonError(405, 'method_not_allowed', `Method ${req.method} not allowed`, { Allow: 'POST' });
  }

  if (!ALLOWED_SUBPATHS.has(subPath)) {
    return jsonError(404, 'not_found', 'Unknown OTEL path');
  }

  const rawContentLength = req.headers.get('content-length');
  if (rawContentLength) {
    const contentLength = Number(rawContentLength);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return jsonError(400, 'invalid_content_length', 'Invalid Content-Length header');
    }
    if (contentLength > MAX_CONTENT_LENGTH_BYTES) {
      return jsonError(413, 'payload_too_large', 'OTLP payload exceeds 10MB limit', undefined, {
        limit_bytes: MAX_CONTENT_LENGTH_BYTES,
      });
    }
  }

  if (inFlightRequests >= MAX_INFLIGHT_REQUESTS) {
    return jsonError(429, 'too_many_requests', 'OTLP proxy is overloaded, retry later');
  }

  let upstreamBody: string | ReadableStream<Uint8Array> | null = req.body;

  // /v1/logs: persist locally for reporting, then return 200 immediately.
  if (subPath === '/v1/logs') {
    if (!req.headers.get('content-encoding')) {
      const bodyText = req.body ? await req.text() : '';
      queueMicrotask(() => persistOtlpLogs(bodyText));
    }
    return new Response(null, { status: 200 });
  }

  // /v1/metrics: persist locally to otel_metrics for reporting and remote upload.
  if (subPath === '/v1/metrics') {
    if (!req.headers.get('content-encoding')) {
      const bodyText = req.body ? await req.text() : '';
      queueMicrotask(() => persistOtlpMetrics(bodyText));
    }
    return new Response(null, { status: 200 });
  }

  // /v1/traces: forwarded to Langfuse. Only this signal needs Langfuse keys.
  // metrics/logs returned earlier during local persistence and never reach here.
  if (!config.langfuse) {
    return jsonError(503, 'not_configured', 'Langfuse credentials not configured');
  }

  const { publicKey, secretKey, baseUrl } = config.langfuse;
  if (!publicKey || !secretKey) {
    return jsonError(503, 'not_configured', 'Langfuse credentials not configured');
  }

  const serviceName = 'agent-telemetry';
  const serviceVersion = '0.1.0';
  const upstream = `${baseUrl.replace(/\/+$/, '')}/api/public/otel${subPath}`;

  if (shouldPatchTraceJson(subPath, req.headers)) {
    const bodyText = req.body ? await req.text() : '';
    try {
      upstreamBody = patchOtelTraceJson(bodyText, serviceName, serviceVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('OTLP trace patch failed, forwarding original JSON text: {message}', { message });
      upstreamBody = bodyText;
    }
  }

  // Build minimal upstream headers — avoid forwarding OTLP exporter headers
  // that nginx/Langfuse may reject (hop-by-hop, traceparent, etc.)
  const headers = new Headers();
  headers.set('Authorization', `Basic ${btoa(`${publicKey}:${secretKey}`)}`);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('x-langfuse-ingestion-version', '4');
  headers.set('x-langfuse-service-name', serviceName);

  const contentEncoding = req.headers.get('content-encoding');
  if (contentEncoding) {
    headers.set('Content-Encoding', contentEncoding);
  }

  inFlightRequests += 1;
  try {
    const resp = await fetch(upstream, {
      method: req.method,
      headers,
      body: upstreamBody,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });

    if (!resp.ok) {
      let upstreamMessage = `Langfuse OTLP upstream returned ${resp.status}`;
      try {
        const contentType = resp.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const json = (await resp.json()) as { error?: { message?: string }; message?: string };
          upstreamMessage = json.error?.message ?? json.message ?? upstreamMessage;
        } else {
          const text = (await resp.text()).trim();
          if (text) upstreamMessage = text.slice(0, 500);
        }
      } catch {
        // Ignore parse failure and keep generic message.
      }

      logger.warn('OTLP upstream error: {upstreamUrl} {status} {message}', {
        upstreamUrl: upstream,
        status: resp.status,
        message: upstreamMessage,
      });
      return jsonError(resp.status, 'otel_upstream_error', upstreamMessage, undefined, {
        upstream_status: resp.status,
      });
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      logger.warn('OTLP proxy timeout after {timeoutMs}ms', { timeoutMs: PROXY_TIMEOUT_MS });
      return jsonError(504, 'otel_proxy_timeout', `OTLP upstream timed out after ${PROXY_TIMEOUT_MS}ms`);
    }

    const message = e instanceof Error ? e.message : String(e);
    logger.warn('OTLP proxy error: {message}', { message });
    return jsonError(502, 'otel_proxy_error', message);
  } finally {
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  }
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

  logger.info('OTLP server listening', { host: config.server.host, port: config.server.port });
  return server;
}
