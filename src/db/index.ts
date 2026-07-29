/**
 * Agent Telemetry — SQLite Database
 *
 * Uses bun:sqlite for zero-dependency embedded database.
 * Tables are compatible with DCC's log_events and otel_metrics schema,
 * but this module is self-contained — no DCC dependency.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';

let db: Database | null = null;

const SCHEMA_SQL = `
-- Log events table (OTLP logs from Claude Code / Codex / OpenCode)
CREATE TABLE IF NOT EXISTS log_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL DEFAULT 'unknown',
  category        TEXT NOT NULL,
  event_name      TEXT NOT NULL,
  tool_name       TEXT,
  success         TEXT,
  session_id      TEXT,
  user_id         TEXT,
  attributes      TEXT NOT NULL DEFAULT '{}',
  resource        TEXT NOT NULL DEFAULT '{}',
  duration_ms     INTEGER,
  timestamp_nano  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  uploaded_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_log_events_pending ON log_events (uploaded_at) WHERE uploaded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_log_events_session ON log_events (session_id);
CREATE INDEX IF NOT EXISTS idx_log_events_category ON log_events (category);
CREATE INDEX IF NOT EXISTS idx_log_events_name ON log_events (event_name);

-- OTLP metrics table
CREATE TABLE IF NOT EXISTS otel_metrics (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider            TEXT NOT NULL DEFAULT 'unknown',
  metric_name         TEXT NOT NULL,
  metric_type         TEXT NOT NULL,
  value               TEXT,
  attributes          TEXT NOT NULL DEFAULT '{}',
  session_id          TEXT,
  user_id             TEXT,
  start_time_unix_nano TEXT,
  time_unix_nano      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  uploaded_at         TEXT,
  resource            TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_otel_metrics_pending ON otel_metrics (uploaded_at) WHERE uploaded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_otel_metrics_provider ON otel_metrics (provider);
CREATE INDEX IF NOT EXISTS idx_otel_metrics_name ON otel_metrics (metric_name);

-- Telemetry events (custom events from this tool or integrations)
CREATE TABLE IF NOT EXISTS telemetry_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  uploaded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_telemetry_pending ON telemetry_events (uploaded_at) WHERE uploaded_at IS NULL;
`;

export function initDb(dataDir: string): void {
  const dbPath = join(dataDir, 'agent-telemetry.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  logger.info('Database initialized', { path: dbPath });
}

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

// ─── Insert helpers ──────────────────────────────────────────────────────────

export interface LogEventInsert {
  provider: string;
  category: string;
  event_name: string;
  tool_name: string | null;
  success: string | null;
  session_id: string | null;
  user_id: string | null;
  attributes: string;
  resource?: string;
  duration_ms: number | null;
  timestamp_nano: string | null;
}

export function insertLogEvents(rows: LogEventInsert[]): void {
  if (rows.length === 0) return;
  const d = getDb();
  d.transaction(() => {
    const stmt = d.prepare(`
      INSERT INTO log_events (provider, category, event_name, tool_name, success, session_id, user_id, attributes, resource, duration_ms, timestamp_nano)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      stmt.run(
        r.provider,
        r.category,
        r.event_name,
        r.tool_name,
        r.success,
        r.session_id,
        r.user_id,
        r.attributes,
        r.resource ?? '{}',
        r.duration_ms,
        r.timestamp_nano,
      );
    }
  })();
}

export interface OtelMetricInsert {
  provider: string;
  metric_name: string;
  metric_type: string;
  value: string | null;
  attributes: string;
  session_id: string | null;
  user_id: string | null;
  start_time_unix_nano: string | null;
  time_unix_nano: string | null;
  resource?: string;
}

export function insertOtelMetrics(rows: OtelMetricInsert[]): void {
  if (rows.length === 0) return;
  const d = getDb();
  d.transaction(() => {
    const stmt = d.prepare(`
      INSERT INTO otel_metrics (provider, metric_name, metric_type, value, attributes, session_id, user_id, start_time_unix_nano, time_unix_nano, resource)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      stmt.run(
        r.provider,
        r.metric_name,
        r.metric_type,
        r.value,
        r.attributes,
        r.session_id,
        r.user_id,
        r.start_time_unix_nano,
        r.time_unix_nano,
        r.resource ?? '{}',
      );
    }
  })();
}

// ─── Query helpers (for reporters) ───────────────────────────────────────────

export function getPendingLogEvents(limit: number) {
  return getDb()
    .query('SELECT * FROM log_events WHERE uploaded_at IS NULL ORDER BY id LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
}

export function markLogEventsUploaded(ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const d = getDb();
  d.transaction(() => {
    const stmt = d.prepare('UPDATE log_events SET uploaded_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  })();
}

export function markLogEventsDiscarded(ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const d = getDb();
  d.transaction(() => {
    const stmt = d.prepare('UPDATE log_events SET uploaded_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  })();
}

export function getPendingOtelMetrics(limit: number) {
  return getDb()
    .query('SELECT * FROM otel_metrics WHERE uploaded_at IS NULL ORDER BY id LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
}

export function markOtelMetricsUploaded(ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const d = getDb();
  d.transaction(() => {
    const stmt = d.prepare('UPDATE otel_metrics SET uploaded_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  })();
}

export function markOtelMetricsDiscarded(ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const d = getDb();
  d.transaction(() => {
    const stmt = d.prepare('UPDATE otel_metrics SET uploaded_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  })();
}
