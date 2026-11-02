import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(),
  schemaVersion: integer("schema_version").notNull().default(1),
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
  revision: integer("revision").notNull().default(1),
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull(),
  nextRunAt: text("next_run_at"),
  lastRunAt: text("last_run_at"),
  overlapPolicy: text("overlap_policy").notNull(),
  taskId: text("task_id"),
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

export const contentEntities = sqliteTable("content_entities", {
  id: text("id").primaryKey(),
  identityKey: text("identity_key").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const runContentResults = sqliteTable("run_content_results", {
  id: text("content_id").notNull().references(() => contentEntities.id),
  runId: text("run_id").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  url: text("url"),
  summary: text("summary").notNull(),
  reason: text("reason").notNull(),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  citationsJson: text("citations_json").notNull().default("[]"),
  score: real("score").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  position: integer("position").notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.id] })]);

export const contentDeliveries = sqliteTable("content_deliveries", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  contentId: text("content_id").notNull().references(() => contentEntities.id),
  scope: text("scope").notNull(),
  channel: text("channel").notNull().default("inbox"),
  provenance: text("provenance").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [unique().on(table.scope, table.channel, table.contentId)]);

export const runReceipts = sqliteTable("run_receipts", {
  runId: text("run_id").primaryKey(),
  inputHash: text("input_hash").notNull(),
  outcome: text("outcome").notNull(),
  digest: text("digest").notNull(),
  itemCount: integer("item_count").notNull(),
  deliveredCount: integer("delivered_count").notNull(),
  provenance: text("provenance").notNull(),
  createdAt: text("created_at").notNull(),
});

export const runRequests = sqliteTable("run_requests", {
  actor: text("actor").notNull(),
  key: text("request_key").notNull(),
  intentHash: text("intent_hash").notNull(),
  runId: text("run_id").notNull().unique(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.actor, table.key] })]);

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

const baseline = [
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

const consistencySchema = [
  `alter table runtime_events rename to runtime_events_legacy`,
  `create table runtime_events (sequence integer primary key autoincrement, id text not null unique, schema_version integer not null default 1, run_id text not null, type text not null, source text not null, severity text not null, timestamp text not null, payload_json text not null)`,
  `insert into runtime_events (id, schema_version, run_id, type, source, severity, timestamp, payload_json) select id, 0, run_id, type, source, severity, timestamp, payload_json from runtime_events_legacy order by rowid`,
  `drop table runtime_events_legacy`,
  `create index runtime_events_run_id_idx on runtime_events (run_id, sequence)`,
  `create table content_entities (id text primary key, identity_key text not null unique, created_at text not null)`,
  `create table run_content_results (run_id text not null, content_id text not null references content_entities(id), title text not null, source text not null, url text, summary text not null, reason text not null, evidence_json text not null, score real not null, status text not null check(status in ('delivered','already_delivered','filtered','failed')), created_at text not null, position integer not null, primary key(run_id, content_id))`,
  `create table content_deliveries (id text primary key, run_id text not null, content_id text not null references content_entities(id), scope text not null, channel text not null default 'inbox', provenance text not null, created_at text not null, unique(scope, channel, content_id))`,
  `create table run_receipts (run_id text primary key, input_hash text not null, outcome text not null check(outcome in ('delivered','no_new_items','legacy_incomplete')), digest text not null, item_count integer not null, delivered_count integer not null, provenance text not null, created_at text not null)`,
  `create table run_requests (actor text not null, request_key text not null, intent_hash text not null, run_id text not null unique, created_at text not null, primary key(actor, request_key))`,
];

export function contentIdentityKey(item: { url?: string | null; source: string; title: string }): string {
  if (item.url) {
    const url = new URL(item.url);
    url.hash = "";
    return `v1:url:${url.href}`;
  }
  return `v1:title:${JSON.stringify([item.source, item.title.replace(/\s+/g, " ").trim()])}`;
}

const legacyContent = z.object({
  id: z.string(), run_id: z.string(), title: z.string(), source: z.string(), url: z.string().nullable(),
  summary: z.string(), reason: z.string(), evidence_json: z.string(), score: z.number(),
  status: z.enum(["delivered", "filtered", "failed"]), created_at: z.string(),
});

function importLegacyContent(database: SqliteDatabase) {
  const { sqlite } = database;
  const rows = sqlite.prepare("select * from content_items order by created_at, rowid").all().map((row) => legacyContent.parse(row));
  for (const [position, row] of rows.entries()) {
    const identityKey = contentIdentityKey(row);
    sqlite.prepare("insert into content_entities values (?, ?, ?) on conflict(identity_key) do nothing").run(row.id, identityKey, row.created_at);
    const identity = z.object({ id: z.string() }).parse(sqlite.prepare("select id from content_entities where identity_key = ?").get(identityKey));
    sqlite.prepare("insert into run_content_results (run_id, content_id, title, source, url, summary, reason, evidence_json, score, status, created_at, position) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing")
      .run(row.run_id, identity.id, row.title, row.source, row.url, row.summary, row.reason, row.evidence_json, row.score, row.status, row.created_at, position);
    if (identity.id !== row.id) sqlite.prepare("update feedback set item_id = ? where item_id = ?").run(identity.id, row.id);
    if (row.status === "delivered") {
      const demo = sqlite.prepare("select 1 from runtime_events where run_id = ? and type = 'run.started' and json_extract(payload_json, '$.trigger') = 'demo'").get(row.run_id);
      sqlite.prepare("insert into content_deliveries values (?, ?, ?, ?, 'inbox', 'legacy_import', ?) on conflict(scope, channel, content_id) do nothing")
        .run(`legacy:${row.run_id}:${identity.id}`, row.run_id, identity.id, demo ? "demo" : "workspace", row.created_at);
    }
  }
  // Old count/digest events lack item membership; never invent missing historical results.
  sqlite.exec(`insert into run_receipts (run_id, input_hash, outcome, digest, item_count, delivered_count, provenance, created_at)
    select e.run_id, 'legacy', 'legacy_incomplete', '',
      (select count(*) from run_content_results r where r.run_id = e.run_id),
      (select count(*) from content_deliveries d where d.run_id = e.run_id), 'legacy_import', min(e.timestamp)
    from runtime_events e where e.type = 'run.started' group by e.run_id`);
  // Retain original nonempty rows for forensic recovery when canonical identities merge.
  sqlite.exec(rows.length > 0 ? "alter table content_items rename to legacy_content_items" : "drop table content_items");
}

export function createSqliteDatabase(path = ":memory:"): SqliteDatabase {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return {
    sqlite,
    db: drizzle(sqlite),
  };
}

const contentTaskSchema = [
  "create table content_tasks (id text primary key, revision integer not null, definition_json text not null, updated_at text not null)",
  "create table run_task_snapshots (run_id text primary key, revision integer not null, definition_json text not null)",
  "create table run_source_reads (run_id text not null references run_task_snapshots(run_id), source_id text not null, result_json text not null, primary key(run_id, source_id))",
  "alter table schedules add column task_id text references content_tasks(id)",
  "update schedules set enabled = 0 where task_id is null",
  "alter table run_content_results add column citations_json text not null default '[]'",
];

const schedulerSchema = [
  "alter table schedules add column revision integer not null default 1",
  `create table scheduled_jobs (
    seq integer primary key autoincrement, run_id text not null unique,
    scope_key text not null, request_target text not null, schedule_id text references schedules(id), schedule_revision integer,
    trigger text not null check(trigger in ('manual','schedule','demo')),
    scheduled_for text, admitted_at text not null, started_at text, finished_at text,
    state text not null check(state in ('queued','running','cancelling','completed','failed','cancelled','skipped')),
    reason text not null
  )`,
  "create index scheduled_jobs_pending on scheduled_jobs(state, seq)",
  "create index scheduled_jobs_scope on scheduled_jobs(scope_key, state)",
  "create index scheduled_jobs_history on scheduled_jobs(schedule_id, seq)",
  "create unique index scheduled_jobs_occurrence on scheduled_jobs(schedule_id, schedule_revision, scheduled_for) where trigger = 'schedule'",
];

const memorySchema = [
  "create table memory_preference_changes (id text primary key, field text not null, key text not null, before_json text not null, after_json text not null, actor text not null, created_at text not null)",
  "alter table memory_entries add column actor text not null default 'legacy'",
  "alter table feedback add column actor text not null default 'legacy'",
  "create table feedback_history (id text primary key, item_id text not null, signal text not null, actor text not null, created_at text not null)",
  "insert into feedback_history select id, item_id, signal, actor, created_at from feedback",
  "delete from feedback where rowid not in (select max(rowid) from feedback group by actor, item_id)",
  "create unique index feedback_actor_item on feedback(actor, item_id)",
  "create table feedback_requests (actor text not null, request_key text not null, intent_hash text not null, receipt_json text not null, primary key(actor,request_key))",
  "create table memory_state (id integer primary key check(id=1), epoch integer not null)",
  "insert into memory_state values (1, 0)",
  "create table run_memory_contexts (run_id text primary key, context_json text not null, context_hash text not null, created_at text not null, epoch integer not null)",
];

const practiceSchema = [
  "create table practice_versions (id text primary key, definition_json text not null, definition_hash text not null, epoch integer not null, actor text not null, created_at text not null)",
  "create table practice_reviews (id text primary key, version_id text not null unique references practice_versions(id), decision text not null check(decision in ('approved','rejected')), actor text not null, reason text not null, created_at text not null)",
  "create table practice_evaluations (id text primary key, version_id text not null references practice_versions(id), report_json text not null, report_hash text not null, created_at text not null)",
  "create table practice_state (id integer primary key check(id=1), version_id text references practice_versions(id), revision integer not null)",
  "insert into practice_state values (1, null, 0)",
  "create table practice_activations (id text primary key, revision integer not null unique, from_id text references practice_versions(id), to_id text references practice_versions(id), evaluation_id text references practice_evaluations(id), action text not null check(action in ('activate','rollback','clear')), actor text not null, created_at text not null)",
];

const localImportSchema = [
  "create table legacy_task_imports (source_key text primary key, manifest_hash text not null, receipt_json text not null, actor text not null, created_at text not null)",
];

export function migrateSqliteDatabase(database: SqliteDatabase): void {
  const { sqlite } = database;
  const migrations = [
    { version: 1, name: "baseline-f320f97", statements: baseline, apply: () => {
      for (const statement of baseline) sqlite.exec(statement);
      const columns = sqlite.prepare("pragma table_info(content_items)").all().map((row) => z.object({ name: z.string() }).parse(row).name);
      if (!columns.includes("evidence_json")) sqlite.exec("alter table content_items add column evidence_json text not null default '[]'");
    } },
    { version: 2, name: "run-content-consistency-v1", statements: consistencySchema, apply: () => {
      for (const statement of consistencySchema) sqlite.exec(statement);
      importLegacyContent(database);
    } },
    { version: 3, name: "content-task-evidence-v1", statements: contentTaskSchema, apply: () => {
      for (const statement of contentTaskSchema) sqlite.exec(statement);
    } },
    { version: 4, name: "durable-scheduler-v1", statements: schedulerSchema, apply: () => {
      for (const statement of schedulerSchema) sqlite.exec(statement);
    } },
    { version: 5, name: "transactional-memory-v1", statements: memorySchema, apply: () => {
      for (const statement of memorySchema) sqlite.exec(statement);
    } },
    { version: 6, name: "reviewed-practice-versions-v1", statements: practiceSchema, apply: () => {
      for (const statement of practiceSchema) sqlite.exec(statement);
    } },
    { version: 7, name: "local-task-import-receipts-v1", statements: localImportSchema, apply: () => {
      for (const statement of localImportSchema) sqlite.exec(statement);
    } },
  ];
  sqlite.transaction(() => {
    sqlite.exec("create table if not exists schema_migrations (version integer primary key, name text not null, checksum text not null, applied_at text not null)");
    const applied = sqlite.prepare("select version, checksum from schema_migrations order by version").all().map((row) => z.object({ version: z.number(), checksum: z.string() }).parse(row));
    if (applied.some((row, index) => row.version !== index + 1 || row.version > migrations.length)) throw new Error("Unsupported database migration version");
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(`${migration.name}\n${migration.statements.join(";\n")}`).digest("hex");
      const existing = applied.find((row) => row.version === migration.version);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${migration.version}`);
        continue;
      }
      migration.apply();
      sqlite.prepare("insert into schema_migrations values (?, ?, ?, ?)").run(migration.version, migration.name, checksum, new Date().toISOString());
    }
  }).immediate();
}
