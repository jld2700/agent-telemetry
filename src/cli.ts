#!/usr/bin/env bun
/**
 * Agent Telemetry — CLI Entry
 *
 * Starts the telemetry server and handles graceful shutdown.
 */

import { startTelemetry } from './index.js';

const telemetry = await startTelemetry();

// Graceful shutdown
process.on('SIGTERM', () => {
  telemetry.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  telemetry.stop();
  process.exit(0);
});
