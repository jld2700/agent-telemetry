/**
 * Agent Telemetry — Main Entry
 *
 * Ties together config, DB, OTLP server, and periodic reporters.
 * Can be used as a library (startTelemetry) or via cli.ts.
 */

import { type TelemetryConfig, loadConfig } from "./config.js";
import { closeDb, initDb } from "./db/index.js";
import {
	startLogEventsReporter,
	stopLogEventsReporter,
} from "./reporters/log-events.js";
import {
	startMetricsReporter,
	stopMetricsReporter,
} from "./reporters/metrics.js";
import { startOtlpServer } from "./routes/otel.js";
import { logger, setLogLevel } from "./utils/logger.js";

export async function startTelemetry(
	configOverrides?: Partial<TelemetryConfig>,
) {
	const config = loadConfig(configOverrides);
	setLogLevel(config.log_level);

	logger.info("Agent Telemetry starting", {
		dataDir: config.data_dir,
		collectLogs: config.collect_logs,
		collectMetrics: config.collect_metrics,
		collectTraces: config.collect_traces,
		agents: Object.keys(config.agents).length,
		forwarders: config.otlp_forwarders.filter((f) => f.enabled).length,
		upstream: config.upstream.url ? "enabled" : "disabled",
	});

	initDb(config.data_dir);

	const server = startOtlpServer(config);
	startLogEventsReporter(config);
	startMetricsReporter(config);

	logger.info("Agent Telemetry started", {
		host: config.server.host,
		port: config.server.port,
	});

	const stop = () => stopTelemetry(server);
	return { config, server, stop };
}

export function stopTelemetry(server?: { stop?: () => void }): void {
	stopLogEventsReporter();
	stopMetricsReporter();
	server?.stop?.();
	closeDb();
	logger.info("Agent Telemetry stopped");
}
