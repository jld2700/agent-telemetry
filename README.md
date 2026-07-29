# agent-telemetry

A standalone [OpenTelemetry](https://opentelemetry.io/) collector for AI coding agents. It receives OTLP telemetry emitted by agents such as **Claude Code**, **Codex**, and **OpenCode**, stores it locally in SQLite, and optionally forwards it to upstream backends or any OTLP-compatible platform.

---

## Why?

AI coding agents emit rich OTLP telemetry — tool calls, token usage, session events — but there's no easy way to **collect, store, and forward** that data locally without standing up a full OpenTelemetry Collector stack. `agent-telemetry` is a single binary that fills that gap:

- 📥 **Receives** OTLP logs, metrics, and traces over HTTP
- 💾 **Stores** everything in a local SQLite database (WAL mode, zero-config)
- 🔒 **Per-agent filtering** — whitelist, blacklist, or collect-all per signal type, configured in YAML
- ⬆️ **Batch upstream reporting** to a custom HTTP backend with auth token
- 🔗 **Multi-target OTLP forwarding** — forward raw OTLP to any OpenTelemetry-compatible platform (Langfuse, Honeycomb, Datadog, Jaeger, Grafana Cloud, Tempo, and more)
- 🔌 **Zero dependencies** at runtime — built on [Bun](https://bun.sh/)

---

## Features

| Feature | Description |
|---|---|
| **OTLP HTTP Receiver** | Accepts `/v1/logs`, `/v1/metrics`, `/v1/traces` in OTLP/JSON |
| **SQLite Storage** | Embedded `bun:sqlite` database with WAL mode for crash-safe, high-throughput writes |
| **YAML Configuration** | Full config via `config.yml` — collection toggles, per-agent filters, upstream, forwarders |
| **Per-Agent Filters** | Whitelist (allow), blacklist (deny), or collect-all (all) for log events, metrics, and traces per agent |
| **Multi-Target OTLP Forwarding** | Forward raw OTLP/HTTP to multiple platforms simultaneously with flexible auth (basic, bearer, header, none) |
| **Upstream Reporting** | Periodic batch forwarding to a configurable HTTP backend with auth token |
| **Multi-Agent Support** | Tags every record with a `provider` field (claude-code, codex, opencode) |
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

Configuration is via a YAML file (`config.yml`). The config file is loaded from:

1. **`AGENT_TELEMETRY_CONFIG` env var** — explicit path to a config file
2. **`config.yml` in the data directory** — defaults to `~/.agent-telemetry/config.yml`
3. **Defaults** — if no config file exists, everything is collected, no forwarding/upstream

A fully documented template is included at [`config.yml`](config.yml) in the project root. Copy it to `~/.agent-telemetry/config.yml` and edit as needed.

### Environment Variable Overrides

The following env vars override the corresponding config file values:

| Variable | Default | Description |
|---|---|---|
| `AGENT_TELEMETRY_CONFIG` | _(none)_ | Path to a custom config.yml file |
| `AGENT_TELEMETRY_DATA_DIR` | `~/.agent-telemetry` | Directory for SQLite DB and config |
| `AGENT_TELEMETRY_HOST` | `127.0.0.1` | HTTP server bind address |
| `AGENT_TELEMETRY_PORT` | `9911` | HTTP server port |
| `AGENT_TELEMETRY_LOG_LEVEL` | `info` | Log level: `debug` \| `info` \| `warn` \| `error` |
| `AGENT_TELEMETRY_UPSTREAM_URL` | _(disabled)_ | Upstream backend URL for batch reporting |
| `AGENT_TELEMETRY_UPSTREAM_TOKEN` | _(none)_ | Bearer token for upstream API auth |

### Per-Agent Filtering

Each agent can have independent filters for `log_events`, `metrics`, and `traces`:

```yaml
agents:
  claude_code:
    log_events:
      mode: allow          # whitelist — only collect listed events
      list:
        - claude_code.tool_result
        - claude_code.api_request
    metrics:
      mode: all            # collect all metrics
      list: []
    traces:
      mode: deny           # blacklist — collect all except listed
      list:
        - claude_code.noisy_trace

  codex:
    log_events:
      mode: allow
      list:
        - codex.conversation_starts
        - codex.user_prompt
        - codex.tool_result
```

**Filter modes:**

| Mode | Behavior |
|---|---|
| `allow` | **Whitelist** — only collect events/metrics/traces whose names are in `list` |
| `deny` | **Blacklist** — collect everything except names in `list` |
| `all` | **Collect everything** — `list` is ignored |

If an agent has no config entry, or a signal type has no filter, all data for that signal is collected.

### OTLP Multi-Target Forwarding

Forward raw OTLP/HTTP payloads to one or more OpenTelemetry-compatible platforms. Each forwarder specifies a URL, auth method, which signal types to forward, and whether it's enabled:

```yaml
otlp_forwarders:
  - name: langfuse
    url: https://langfuse.example.com/api/otel
    auth:
      type: basic
      username: pk-xxx
      password: sk-xxx
    signals: [traces, logs]
    enabled: true

  - name: honeycomb
    url: https://api.honeycomb.io
    auth:
      type: bearer
      token: xxx
    signals: [traces, logs, metrics]
    enabled: true

  - name: datadog
    url: https://trace.agent.datadoghq.eu
    auth:
      type: header
      headers:
        X-Datadog-API-Key: xxx
    signals: [traces]
    enabled: false
```

**Auth types:**

| Type | Description | Fields |
|---|---|---|
| `basic` | HTTP Basic Auth | `username`, `password` |
| `bearer` | Bearer token | `token` |
| `header` | Custom headers | `headers` (map of key-value pairs) |
| `none` | No authentication | _(none)_ |

**Supported OTLP platforms:**

| Platform | Auth Type | Notes |
|---|---|---|
| [Langfuse](https://langfuse.com/) | `basic` | URL: `https://cloud.langfuse.com/api/public/otel` |
| [Honeycomb](https://www.honeycomb.io/) | `bearer` | Use API key as bearer token |
| [Datadog](https://www.datadoghq.com/) | `header` | `X-Datadog-API-Key` header |
| [Jaeger](https://www.jaegertracing.io/) | `none` | Local: `http://jaeger:4318` |
| [Tempo](https://grafana.com/oss/tempo/) | `none` / `basic` | Local or Grafana Cloud |
| [Grafana Cloud](https://grafana.com/) | `basic` | OTLP endpoint in Grafana dashboard |
| [New Relic](https://newrelic.com/) | `header` | `Api-Key` header |
| [Splunk Observability](https://splunk.com/) | `bearer` | Access token as bearer |

Forwarding is **fire-and-forget** — the agent receives a 200 response immediately; forwarder errors are logged but don't block.

### Upstream Batch Reporting

Periodic batch upload of locally-stored log events and metrics to a custom HTTP backend:

```yaml
upstream:
  url: "https://my-backend.example.com/api/telemetry"
  token: "my-secret-token"
  batch_size: 500
  interval_ms: 600000      # 10 minutes
  report_logs: true
  report_metrics: true
```

The upstream backend should accept `POST /v1/logs` and `POST /v1/metrics` with JSON payloads and respond with `{ ok: true, accepted: [...], failed: [...] }`.

---

## Architecture

```
 ┌──────────────┐   ┌──────────┐   ┌───────────┐
 │ Claude Code  │   │  Codex   │   │ OpenCode  │
 └──────┬───────┘   └────┬─────┘   └─────┬─────┘
        │                │               │
        │   OTLP/HTTP    │   OTLP/HTTP   │
        ▼                ▼               ▼
  ┌─────────────────────────────────────────────────┐
  │              agent-telemetry                     │
  │  ┌─────────┐  ┌─────────┐  ┌────────────────┐  │
  │  │ Receiver│→ │  Parser │→ │ Config Filter  │  │
  │  │ (HTTP)  │  │ (OTLP)  │  │ (shouldCollect)│  │
  │  └─────────┘  └─────────┘  └───────┬────────┘  │
  │                                    │            │
  │           ┌────────────────────────┼────────┐   │
  │           ▼                        ▼        │   │
  │     ┌──────────┐          ┌───────────────┐ │   │
  │     │  SQLite  │          │  OTLP Forward │ │   │
  │     │  Store   │          │  (multi-target)│ │   │
  │     └────┬─────┘          └───────┬───────┘ │   │
  │          │                       │         │   │
  │     ┌────▼─────┐                 │         │   │
  │     │ Upstream │                 │         │   │
  │     │ Reporter │          ┌──────┼──────┐  │   │
  │     └──────────┘          ▼      ▼      ▼  │   │
  └────────────────────  Langfuse Honeycomb …  ────┘
```

---

## API

`agent-telemetry` exposes OTLP-compatible HTTP endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/v1/logs` | `POST` | OTLP logs — receives log records from agents |
| `/v1/metrics` | `POST` | OTLP metrics — receives metric data points |
| `/v1/traces` | `POST` | OTLP traces — receives span data (forwarded if configured) |

All endpoints accept OTLP/JSON payloads (`Content-Type: application/json`). Requests return `200 OK` on success.

### Example request

```bash
curl -X POST http://127.0.0.1:9911/v1/logs \
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
| `provider` | TEXT | Agent source: `claude`, `codex`, `opencode` |
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
| `metric_type` | TEXT | Metric type: `sum`, `gauge`, `histogram` |
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
│   ├── cli.ts                      # CLI entry point
│   ├── index.ts                    # Programmatic API
│   ├── config.ts                   # YAML config loader
│   ├── db/
│   │   └── index.ts                # SQLite database (bun:sqlite)
│   ├── parsers/
│   │   ├── otel-logs.ts            # Claude Code OTLP logs parser
│   │   ├── otel-codex-logs.ts      # Codex OTLP logs parser
│   │   ├── otel-opencode-logs.ts   # OpenCode OTLP logs parser
│   │   ├── otel-metrics.ts         # OTLP metrics parser
│   │   └── types.ts                # Shared OTLP type definitions
│   ├── routes/
│   │   └── otel.ts                 # OTLP HTTP handler + multi-target forwarding
│   ├── reporters/
│   │   ├── log-events.ts           # Upstream log events batch reporter
│   │   └── metrics.ts              # Upstream metrics batch reporter
│   └── utils/
│       ├── logger.ts               # Structured logger
│       └── filter.ts               # Per-agent filter utility (shouldCollect)
├── config.yml                      # Config template (copy to ~/.agent-telemetry/)
├── package.json
├── tsconfig.json
└── README.md
```

---

## License

[MIT](LICENSE) © 2024 Nous Research
