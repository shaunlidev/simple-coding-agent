import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteDatabase, migrateSqliteDatabase } from "../src/index.ts";

test("db package opens an in-memory SQLite database", () => {
  const { sqlite } = createSqliteDatabase(":memory:");
  const result = sqlite.prepare("select 1 as ok").get() as { ok: number };

  assert.equal(result.ok, 1);
  sqlite.close();
});

test("db migration is idempotent and creates runtime tables", () => {
  const database = createSqliteDatabase(":memory:");
  migrateSqliteDatabase(database);
  migrateSqliteDatabase(database);
  const tables = database.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
  const names = new Set(tables.map((table) => table.name));

  assert.equal(names.has("runtime_events"), true);
  assert.equal(names.has("runs"), true);
  assert.equal(names.has("schedules"), true);
  assert.equal(names.has("content_entities"), true);
  assert.equal(names.has("run_content_results"), true);
  assert.equal(names.has("content_deliveries"), true);
  assert.equal(names.has("run_receipts"), true);
  assert.equal(names.has("content_items"), false);
  assert.equal(names.has("tool_approvals"), true);
  database.sqlite.close();
});
