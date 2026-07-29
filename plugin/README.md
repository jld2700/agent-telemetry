# agent-telemetry Claude Code Plugin

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that auto-injects OpenTelemetry (OTLP) environment variables into `~/.claude/settings.json` when installed — no manual configuration needed.

## What It Does

When you install this plugin, Claude Code automatically injects the following environment variables into its global settings:

| Variable | Value | Purpose |
|---|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` | Enables Claude Code's built-in OTLP telemetry |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` | `1` | Enables enhanced (beta) telemetry fields — richer tool call details |
| `OTEL_TRACES_EXPORTER` | `otlp` | Route traces to the OTLP exporter |
| `OTEL_METRICS_EXPORTER` | `otlp` | Route metrics to the OTLP exporter |
| `OTEL_LOGS_EXPORTER` | `otlp` | Route logs to the OTLP exporter |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` | Use HTTP/JSON as the OTLP transport |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:9911/api/otel` | Point the exporter at the local agent-telemetry collector |
| `OTEL_LOG_TOOL_DETAILS` | `1` | Include detailed tool call information in log events |
| `CLAUDE_CODE_PROPAGATE_TRACEPARENT` | `1` | Propagate W3C trace context across requests |

After installation and a restart of Claude Code, every tool call, model invocation, and session event will be captured and sent to the agent-telemetry collector running on your machine.

## Prerequisites

The **agent-telemetry service must be running** before you start Claude Code. Install it first:

```bash
# From source (Bun)
git clone https://github.com/nousresearch/agent-telemetry.git
cd agent-telemetry
bun install
bun run dev

# Or build a standalone binary
bun run build
./agent-telemetry

# Or download a pre-built binary from the Releases page
```

By default the collector listens on `http://127.0.0.1:9911`.

> **Note:** The `OTEL_EXPORTER_OTLP_ENDPOINT` in this plugin points at `http://127.0.0.1:9911/api/otel`. If you run agent-telemetry on a different host or port, either change the endpoint in `plugin/.claude-plugin/plugin.json` before installing, or override `OTEL_EXPORTER_OTLP_ENDPOINT` in your shell environment.

## Install

From the root of this repository:

```bash
claude plugin install /path/to/agent-telemetry/plugin
```

For example, if you cloned agent-telemetry to `~/code/agent-telemetry`:

```bash
claude plugin install ~/code/agent-telemetry/plugin
```

Claude Code will read `plugin.json`, merge the `env` block into `~/.claude/settings.json`, and apply the environment variables on the next session.

## Uninstall

```bash
claude plugin uninstall agent-telemetry
```

This removes the injected environment variables from `~/.claude/settings.json`.

## Verify

After installing and restarting Claude Code, confirm telemetry is flowing:

```bash
sqlite3 ~/.agent-telemetry/agent-telemetry.db \
  "SELECT provider, category, event_name, COUNT(*) FROM log_events GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20;"
```

You should see `claude-code` rows appearing as you use Claude Code.
