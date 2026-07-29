# Architecture

This document describes the internal architecture and data flow of `agent-telemetry`.

## Overview

`agent-telemetry` is a standalone OpenTelemetry collector designed specifically for AI coding agents. It sits between the agent (which emits OTLP telemetry) and any downstream observability backends. The core design principle is **locality**: telemetry is captured and stored locally first, then asynchronously forwarded — so agents never block on telemetry delivery.

## Data Flow

```
 ┌──────────────┐     ┌──────────┐     ┌───────────┐
 │ Claude Code  │     │  Codex   │     │ OpenCode  │
 └──────┬───────┘     └────┬─────┘     └─────┬─────┘
        │                  │                 │
        │  OTLP/HTTP       │  OTLP/HTTP      │  OTLP/HTTP
        │  (logs,metrics,  │                 │
        │   traces)        │                 │
        ▼                  ▼                 ▼
  ┌─────────────────────────────────────────────────────┐
  │                  agent-telemetry                    │
  │                                                     │
  │  ┌─────────────┐                                    │
  │  │  HTTP Server│  (Hono/Bun, port 9911)             │
  │  │  Receiver   │                                    │
  │  └──────┬──────┘                                    │
  │         │                                           │
  │         ▼                                           │
  │  ┌─────────────┐    ┌─────────────┐                 │
  │  │  OTLP       │───▶│  Parsers    │                 │
  │  │  Router     │    │  (Protobuf/ │                 │
  │  │             │    │   JSON)     │                 │
  │  └──────┬──────┘    └─────────────┘                 │
  │         │                                           │
  │         ▼                                           │
  │  ┌─────────────────────────────────────┐            │
  │  │         SQLite Storage              │            │
  │  │  ┌─────────────┐ ┌──────────────┐  │            │
  │  │  │ log_events  │ │ otel_metrics │  │            │
  │  │  └─────────────┘ └──────────────┘  │            │
  │  │  ┌──────────────────────────────┐  │            │
  │  │  │     telemetry_events         │  │            │
  │  │  └──────────────────────────────┘  │            │
  │  │     (WAL mode, bun:sqlite)        │            │
  │  └──────────────┬────────────────────┘            │
  │                 │                                   │
  │        ┌────────┴────────┐                         │
  │        ▼                 ▼                         │
  │  ┌───────────┐   ┌───────────────┐                │
  │  │ Upstream  │   │   Langfuse    │                │
  │  │ Reporter  │   │   Reporter    │                │
  │  │ (batch)   │   │  (OTLP→LF)    │                │
  │  └─────┬─────┘   └──────┬────────┘                │
  └────────┼─────────────────┼─────────────────────────┘
           │                 │
           ▼                 ▼
  ┌────────────────┐ ┌──────────────────┐
  │  Upstream API  │ │  Langfuse Cloud  │
  │  (custom       │ │  (or self-hosted)│
  │   backend)     │ │                  │
  └────────────────┘ └──────────────────┘
```

## Components

### 1. HTTP Receiver

The entry point for all telemetry. A lightweight HTTP server (Bun native) listens on port 9911 by default and exposes three OTLP-compatible endpoints:

| Endpoint | OTLP Signal |
|---|---|
| `/api/otel/v1/logs` | Logs |
| `/v1/metrics` | Metrics |
| `/v1/traces` | Traces |

The receiver accepts both OTLP/JSON and OTLP/Protobuf payloads. It does minimal work — just validates the request and passes the raw payload to the parser layer. This keeps the receive path fast so agents are never blocked.

### 2. Parsers

Parsers decode OTLP payloads into the internal row format:

- **OTLP Parser** — Converts OTLP JSON/Protobuf into structured `LogEventInsert` and `OtelMetricInsert` rows. Extracts provider from resource attributes (`service.name`), normalizes timestamps, and flattens nested attributes into JSON strings.
- **Route Handlers** — Map HTTP paths to the appropriate parser and storage call. Each handler is responsible for one OTLP signal type.

### 3. SQLite Storage

The persistent store. Uses `bun:sqlite` with WAL journal mode for high write throughput and crash safety. Three tables:

- **`log_events`** — OTLP log records (tool calls, session events, model invocations)
- **`otel_metrics`** — OTLP metric data points (token counts, durations)
- **`telemetry_events`** — Custom events from the tool itself or integrations

Each row carries an `uploaded_at` column that is `NULL` until a reporter successfully forwards it. This provides at-least-once delivery semantics: rows are only marked as uploaded after a successful upstream/Langfuse response. Reporters query for `WHERE uploaded_at IS NULL` to find pending batches.

**Indexes:** Partial indexes on `uploaded_at IS NULL` enable fast pending-row queries without scanning the full table. Additional indexes on `session_id`, `category`, `event_name`, and `metric_name` support common analytical queries.

### 4. Upstream Reporter

A periodic batch forwarder that sends pending rows to a configurable HTTP backend:

- Runs on a configurable interval (`AGENT_TELEMETRY_LOG_INTERVAL`, default 10 min)
- Batches pending rows (configurable batch size)
- Sends to `AGENT_TELEMETRY_UPSTREAM_URL` with optional bearer token auth
- On success: marks rows as uploaded (`uploaded_at = now`)
- On failure: rows remain pending and are retried next cycle
- Uses `markLogEventsDiscarded()` for permanently failed rows (e.g. 4xx errors)

### 5. Langfuse Reporter

Converts OTLP traces and logs into Langfuse-compatible events for LLM observability:

- Translates OTLP spans into Langfuse generations/traces
- Maps token metrics to Langfuse usage fields
- Forwards to `AGENT_TELEMETRY_LANGFUSE_BASE_URL` using public/secret key auth
- Runs on the same batch interval as the upstream reporter
- Independent of the upstream reporter — both can run simultaneously

## Design Principles

1. **Local-first** — Telemetry is stored locally before any forwarding. Agents and local queries never depend on network availability.
2. **Zero-config defaults** — Works out of the box with `bun run dev`. SQLite, WAL mode, and sensible intervals are all defaults.
3. **At-least-once delivery** — The `uploaded_at` watermark ensures rows are retried until confirmed by a downstream system.
4. **No external dependencies** — Built entirely on Bun's built-in APIs (`bun:sqlite`, `Bun.serve`). No Docker, no Postgres, no Redis.
5. **Multi-agent** — Every record is tagged with a `provider` field so data from Claude Code, Codex, and OpenCode can coexist and be filtered independently.

## Configuration Flow

```
  Environment Variables (AGENT_TELEMETRY_*)
         │
         ▼
  ┌──────────────┐
  │  config.ts   │  ← loadConfig()
  │  (defaults + │     merges: defaults → env → overrides
  │   env merge) │
  └──────┬───────┘
         │
         ▼
  TelemetryConfig {
    dataDir, server, upstream?, langfuse?,
    intervals, logLevel
  }
         │
    ┌────┴────┐
    ▼         ▼
  initDb()  HTTP Server + Reporters
```

## Process Lifecycle

```
  Start
    │
    ├──▶ initDb(dataDir)          # Create SQLite DB, run schema migrations
    ├──▶ Start HTTP Server        # Begin accepting OTLP on configured port
    ├──▶ Start Upstream Reporter  # setInterval() — only if upstream configured
    ├──▶ Start Langfuse Reporter  # setInterval() — only if langfuse configured
    │
    │   ... running ...
    │
    ├──▶ SIGINT/SIGTERM
    ├──▶ Stop HTTP Server
    ├──▶ Flush reporters (final batch)
    ├──▶ closeDb()
    └──▶ Exit
```
