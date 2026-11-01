import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  trigger: text("trigger").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  durationMs: integer("duration_ms"),
  costUsd: real("cost_usd").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
});

export const runtimeEvents = sqliteTable("runtime_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  type: text("type").notNull(),
  source: text("source").notNull(),
  severity: text("severity").notNull(),
  timestamp: text("timestamp").notNull(),
  payloadJson: text("payload_json").notNull(),
});

export const spans = sqliteTable("spans", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  parentId: text("parent_id"),
  type: text("type").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  summary: text("summary").notNull(),
});

export const metrics = sqliteTable("metrics", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  name: text("name").notNull(),
  value: real("value").notNull(),
  unit: text("unit").notNull(),
  createdAt: text("created_at").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull(),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
  overlapPolicy: text("overlap_policy").notNull(),
});

export const memoryEntries = sqliteTable("memory_entries", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  sourceTrust: text("source_trust").notNull(),
  content: text("content").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull(),
  signal: text("signal").notNull(),
  createdAt: text("created_at").notNull(),
});

export const contentItems = sqliteTable("content_items", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  url: text("url"),
  summary: text("summary").notNull(),
  reason: text("reason").notNull(),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  score: real("score").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const evalReports = sqliteTable("eval_reports", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  score: real("score").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const securityAudit = sqliteTable("security_audit", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  action: text("action").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
});

export const toolApprovals = sqliteTable("tool_approvals", {
  id: text("id").primaryKey(),
  tool: text("tool").notNull(),
  risk: text("risk").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
});

export type SqliteDatabase = {
  sqlite: BetterSqlite3.Database;
  db: BetterSQLite3Database;
};

const migrations = [
  `create table if not exists execution_approvals (id text primary key, run_id text not null, tool text not null, args_hash text not null, requested_by text not null, approved_by text, status text not null check (status in ('pending','approved','consumed','denied')), expires_at integer not null, consumed_at integer, created_at integer not null)`,
  `create table if not exists auth_sessions (id_hash text primary key, generation text not null, payload_json text not null, expires_at integer not null)`,
  `create index if not exists auth_sessions_expiry_idx on auth_sessions (expires_at)`,
  `create table if not exists runs (id text primary key, task_id text not null, title text not null, status text not null, trigger text not null, started_at text, completed_at text, duration_ms integer, cost_usd real not null default 0, input_tokens integer not null default 0, output_tokens integer not null default 0)`,
  `create table if not exists runtime_events (id text primary key, run_id text not null, type text not null, source text not null, severity text not null, timestamp text not null, payload_json text not null)`,
  `create table if not exists spans (id text primary key, run_id text not null, parent_id text, type text not null, name text not null, status text not null, started_at text not null, duration_ms integer not null default 0, cost_usd real not null default 0, input_tokens integer not null default 0, output_tokens integer not null default 0, summary text not null)`,
  `create table if not exists metrics (id text primary key, run_id text, name text not null, value real not null, unit text not null, created_at text not null)`,
  `create table if not exists schedules (id text primary key, title text not null, enabled integer not null default 1, cron text not null, timezone text not null, next_run_at text, last_run_at text, overlap_policy text not null)`,
  `create table if not exists content_items (id text primary key, run_id text not null, title text not null, source text not null, url text, summary text not null, reason text not null, evidence_json text not null default '[]', score real not null, status text not null, created_at text not null)`,
  `create table if not exists memory_entries (id text primary key, kind text not null, source_trust text not null, content text not null, metadata_json text not null, created_at text not null)`,
  `create table if not exists feedback (id text primary key, item_id text not null, signal text not null, created_at text not null)`,
  `create table if not exists eval_reports (id text primary key, name text not null, status text not null, score real not null, evidence_json text not null, created_at text not null)`,
  `create table if not exists security_audit (id text primary key, run_id text, action text not null, severity text not null, message text not null, created_at text not null)`,
  `create table if not exists tool_approvals (id text primary key, tool text not null, risk text not null, status text not null, reason text not null, created_at text not null)`,
  `create index if not exists runtime_events_run_id_idx on runtime_events (run_id)`,
  `create index if not exists runtime_events_timestamp_idx on runtime_events (timestamp)`,
  `create virtual table if not exists memory_fts using fts5(id, kind, content, metadata_json)`,
];

const optionalMigrations = [
  `alter table content_items add column evidence_json text not null default '[]'`,
];

export function createSqliteDatabase(path = ":memory:"): SqliteDatabase {
  const sqlite = new Database(path);
  return {
    sqlite,
    db: drizzle(sqlite),
  };
}

export function migrateSqliteDatabase(database: SqliteDatabase): void {
  for (const statement of migrations) {
    database.sqlite.exec(statement);
  }
  for (const statement of optionalMigrations) {
    try {
      database.sqlite.exec(statement);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
    }
  }
}
