# agent-telemetry

A standalone [OpenTelemetry](https://opentelemetry.io/) collector for AI coding agents. It receives OTLP telemetry emitted by agents such as **Claude Code**, **Codex**, and **OpenCode**, stores it locally in SQLite, and optionally forwards it to upstream backends or [Langfuse](https://langfuse.com/).

---

## Why?

AI coding agents emit rich OTLP telemetry — tool calls, token usage, session events — but there's no easy way to **collect, store, and forward** that data locally without standing up a full OpenTelemetry Collector stack. `agent-telemetry` is a single binary that fills that gap:

- 📥 **Receives** OTLP logs, metrics, and traces over HTTP
- 💾 **Stores** everything in a local SQLite database (WAL mode, zero-config)
- ⬆️ **Forwards** to an upstream backend (e.g. DCC service, custom API)
- 🔗 **Forwards** to Langfuse for LLM observability and tracing
- 🔌 **Zero dependencies** at runtime — built on [Bun](https://bun.sh/)

---

## Features

| Feature | Description |
|---|---|
| **OTLP HTTP Receiver** | Accepts `/api/otel/v1/logs`, `/v1/metrics`, `/v1/traces` in OTLP/Protobuf and OTLP/JSON |
| **SQLite Storage** | Embedded `bun:sqlite` database with WAL mode for crash-safe, high-throughput writes |
| **Upstream Reporting** | Periodic batch forwarding to a configurable HTTP backend with auth token |
| **Langfuse Forwarding** | Converts OTLP traces/logs into Langfuse-compatible events for LLM tracing |
| **Multi-Agent Support** | Tags every record with a `provider` field (claude-code, codex, opencode) |
| **Configurable Intervals** | Independent batch intervals for log events and metrics |
| **Programmatic API** | Can be used as a library, not just a CLI |

---

## Install

### From source (Bun)

```bash
git clone https://github.com/nousresearch/agent-telemetry.git
cd agent-telemetry
bun install
```

### Build a standalone binary

```bash
bun run build
# → produces ./agent-telemetry (self-contained executable)
```

### Download binary

Pre-built binaries are available on the [Releases](https://github.com/nousresearch/agent-telemetry/releases) page.

---

## Quick Start

1. **Start the collector:**

   ```bash
   bun run dev
   # or, if you built the binary:
   ./agent-telemetry
   ```

   By default it listens on `http://127.0.0.1:9911`.

2. **Point your agent at it.** Set the OTLP endpoint environment variable so the agent sends telemetry to `agent-telemetry` instead of a remote collector:

   ```bash
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9911
   ```

3. **Run your agent** (Claude Code, Codex, OpenCode) as usual. Telemetry flows into the local SQLite database at `~/.agent-telemetry/agent-telemetry.db`.

4. **Query the data:**

   ```bash
   sqlite3 ~/.agent-telemetry/agent-telemetry.db \
     "SELECT provider, category, event_name, COUNT(*) FROM log_events GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20;"
   ```

---

## Configuration

All configuration is via environment variables with the `AGENT_TELEMETRY_` prefix. An optional `agent-telemetry.toml` or `.json` config file in the data directory is also supported.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_TELEMETRY_DATA_DIR` | `~/.agent-telemetry` | Directory for SQLite DB and logs |
| `AGENT_TELEMETRY_HOST` | `127.0.0.1` | HTTP server bind address |
| `AGENT_TELEMETRY_PORT` | `9911` | HTTP server port |
| `AGENT_TELEMETRY_UPSTREAM_URL` | _(disabled)_ | Upstream backend URL for batch forwarding |
| `AGENT_TELEMETRY_UPSTREAM_TOKEN` | _(none)_ | Bearer token for upstream API auth |
| `AGENT_TELEMETRY_LANGFUSE_BASE_URL` | _(disabled)_ | Langfuse instance URL |
| `AGENT_TELEMETRY_LANGFUSE_PUBLIC_KEY` | _(none)_ | Langfuse public key |
| `AGENT_TELEMETRY_LANGFUSE_SECRET_KEY` | _(none)_ | Langfuse secret key |
| `AGENT_TELEMETRY_LOG_INTERVAL` | `600000` | Log event reporting interval (ms) |
| `AGENT_TELEMETRY_METRICS_INTERVAL` | `600000` | Metrics reporting interval (ms) |
| `AGENT_TELEMETRY_LOG_LEVEL` | `info` | Log level: `debug` \| `info` \| `warn` \| `error` |

### Example `.env`

```bash
AGENT_TELEMETRY_PORT=9911
AGENT_TELEMETRY_LOG_LEVEL=debug

# Forward to a custom backend
AGENT_TELEMETRY_UPSTREAM_URL=https://my-backend.example.com/api/telemetry
AGENT_TELEMETRY_UPSTREAM_TOKEN=sk-xxxxxxxxxxxx

# Forward to Langfuse
AGENT_TELEMETRY_LANGFUSE_BASE_URL=https://cloud.langfuse.com
AGENT_TELEMETRY_LANGFUSE_PUBLIC_KEY=pk-lf-xxxx
AGENT_TELEMETRY_LANGFUSE_SECRET_KEY=sk-lf-xxxx
```

---

## Architecture

```
 ┌──────────────┐   ┌──────────┐   ┌───────────┐
 │ Claude Code  │   │  Codex   │   │ OpenCode  │
 └──────┬───────┘   └────┬─────┘   └─────┬─────┘
        │                │               │
        │   OTLP/HTTP    │   OTLP/HTTP   │
        ▼                ▼               ▼
  ┌─────────────────────────────────────────────┐
  │            agent-telemetry                  │
  │  ┌─────────┐  ┌─────────┐  ┌────────────┐  │
  │  │ Receiver│→ │  Parser │→ │   Store    │  │
  │  │ (HTTP)  │  │ (OTLP)  │  │  (SQLite)  │  │
  │  └─────────┘  └─────────┘  └─────┬──────┘  │
  │                                   │         │
  │           ┌───────────────────────┼─────┐   │
  │           ▼                       ▼     │   │
  │     ┌──────────┐          ┌──────────┐  │   │
  │     │ Upstream │          │ Langfuse │  │   │
  │     │ Reporter │          │ Reporter │  │   │
  │     └──────────┘          └──────────┘  │   │
  └─────────────────────────────────────────┘   │
                                                │
                        ┌───────────────────────┘
                        ▼
              ┌──────────────────┐
              │  SQLite Database │
              │  ~/.agent-       │
              │  telemetry/      │
              └──────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for a detailed component breakdown.

---

## API

`agent-telemetry` exposes OTLP-compatible HTTP endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/api/otel/v1/logs` | `POST` | OTLP logs — receives log records from agents |
| `/v1/metrics` | `POST` | OTLP metrics — receives metric data points |
| `/v1/traces` | `POST` | OTLP traces — receives span data (forwarded to Langfuse if enabled) |

All endpoints accept OTLP/JSON payloads (`Content-Type: application/json`). Requests return `200 OK` on success.

### Example request

```bash
curl -X POST http://127.0.0.1:9911/api/otel/v1/logs \
  -H "Content-Type: application/json" \
  -d '{
    "resourceLogs": [{
      "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "claude-code" }}]},
      "scopeLogs": [{
        "logRecords": [{
          "timeUnixNano": "1700000000000000000",
          "body": { "stringValue": "tool_call" },
          "attributes": [
            { "key": "event.name", "value": { "stringValue": "tool.execution" }},
            { "key": "tool.name", "value": { "stringValue": "Read" }}
          ]
        }]
      }]
    }]
  }'
```

---

## Database Schema

The SQLite database (`agent-telemetry.db`) contains three tables:

### `log_events`

OTLP log records from agents — tool calls, session events, user actions.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment ID |
| `provider` | TEXT | Agent source: `claude-code`, `codex`, `opencode` |
| `category` | TEXT | Event category (e.g. `tool`, `session`, `model`) |
| `event_name` | TEXT | Specific event name |
| `tool_name` | TEXT \| NULL | Tool name if applicable |
| `success` | TEXT \| NULL | Success/failure flag |
| `session_id` | TEXT \| NULL | Agent session ID |
| `user_id` | TEXT \| NULL | User identifier |
| `attributes` | TEXT (JSON) | Full OTLP attributes as JSON |
| `resource` | TEXT (JSON) | OTLP resource attributes |
| `duration_ms` | INTEGER \| NULL | Event duration in ms |
| `timestamp_nano` | TEXT \| NULL | Original OTLP timestamp |
| `created_at` | TEXT | Ingest time (UTC ISO 8601) |
| `uploaded_at` | TEXT \| NULL | Set when forwarded upstream |

### `otel_metrics`

OTLP metric data points — token counts, durations, counters.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment ID |
| `provider` | TEXT | Agent source |
| `metric_name` | TEXT | Metric name (e.g. `token_count`) |
| `metric_type` | TEXT | Metric type: `counter`, `gauge`, `histogram` |
| `value` | TEXT | Metric value (string-encoded) |
| `attributes` | TEXT (JSON) | Metric attributes |
| `session_id` | TEXT \| NULL | Agent session ID |
| `user_id` | TEXT \| NULL | User identifier |
| `start_time_unix_nano` | TEXT \| NULL | Metric start timestamp |
| `time_unix_nano` | TEXT \| NULL | Metric timestamp |
| `resource` | TEXT (JSON) | OTLP resource attributes |
| `created_at` | TEXT | Ingest time (UTC ISO 8601) |
| `uploaded_at` | TEXT \| NULL | Set when forwarded upstream |

### `telemetry_events`

Custom events from this tool or integrations.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment ID |
| `event` | TEXT | Event name |
| `payload` | TEXT (JSON) | Event payload as JSON |
| `created_at` | TEXT | Ingest time (UTC ISO 8601) |
| `uploaded_at` | TEXT \| NULL | Set when forwarded upstream |

---

## Agent Integration

### Claude Code

Set the OTLP endpoint in your environment or Claude Code settings:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9911
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Or add to your `~/.claude/settings.json`:

```json
{
  "env": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:9911",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json"
  }
}
```

Start `agent-telemetry`, then launch Claude Code. All tool calls, model invocations, and session events will be captured.

### Codex (OpenAI)

Set the OTLP endpoint before launching Codex:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9911
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Codex reads standard OpenTelemetry environment variables. Ensure `agent-telemetry` is running before starting a Codex session.

### OpenCode

Set the OTLP endpoint in your environment or OpenCode config:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9911
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Or configure in your OpenCode settings file (`~/.opencode/config.json` or equivalent):

```json
{
  "otel": {
    "endpoint": "http://127.0.0.1:9911",
    "protocol": "http/json"
  }
}
```

---

## Development

```bash
# Install dependencies
bun install

# Run in dev mode (hot reload)
bun run dev

# Type check
bun run typecheck

# Lint & format
bun run lint
bun run format

# Run tests
bun test

# Build standalone binary
bun run build
```

### Project Structure

```
agent-telemetry/
├── src/
│   ├── cli.ts              # CLI entry point
│   ├── index.ts            # Programmatic API
│   ├── config.ts           # Configuration loader
│   ├── db/
│   │   └── index.ts        # SQLite database (bun:sqlite)
│   ├── parsers/
│   │   ├── otlp.ts         # OTLP Protobuf/JSON parser
│   │   └── routes.ts       # HTTP route handlers
│   ├── reporters/
│   │   ├── upstream.ts     # Upstream backend reporter
│   │   └── langfuse.ts     # Langfuse forwarding reporter
│   └── utils/
│       └── logger.ts       # Structured logger
├── docs/
│   └── architecture.md     # Architecture documentation
├── package.json
├── tsconfig.json
└── README.md
```

---

## License

[MIT](LICENSE) © 2024 Nous Research
