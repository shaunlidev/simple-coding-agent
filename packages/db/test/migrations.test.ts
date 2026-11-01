import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteDatabase, migrateSqliteDatabase } from "../src/index.ts";

function oldDatabase(withEvidence: boolean) {
  const database = createSqliteDatabase();
  database.sqlite.exec(`
    create table runtime_events (id text primary key, run_id text not null, type text not null, source text not null, severity text not null, timestamp text not null, payload_json text not null);
    create table content_items (id text primary key, run_id text not null, title text not null, source text not null, url text, summary text not null, reason text not null, ${withEvidence ? "evidence_json text not null default '[]'," : ""} score real not null, status text not null, created_at text not null);
    insert into runtime_events values ('start', 'old-run', 'run.started', 'fixture', 'info', '2026-08-25T10:00:00Z', '{"title":"Old run","trigger":"manual"}');
    insert into runtime_events values ('claimed-delivery', 'old-run', 'delivery.created', 'fixture', 'info', '2026-08-25T09:00:00Z', '{"count":2,"digest":"Legacy digest claims two items"}');
    insert into runtime_events values ('missing-start', 'missing-run', 'run.started', 'fixture', 'info', '2026-08-25T11:00:00Z', '{"title":"Lost result","trigger":"manual"}');
    insert into content_items (id, run_id, title, source, url, summary, reason, score, status, created_at)
      values ('old-id', 'old-run', 'Surviving item', 'fixture', 'https://example.test/a', 'Original summary', 'Original reason', 73, 'delivered', '2026-08-25T10:01:00Z');
  `);
  return database;
}

for (const withEvidence of [false, true]) {
  test(`R3.5 baseline upgrade preserves surviving results without inventing missing history (evidence=${withEvidence})`, () => {
    const database = oldDatabase(withEvidence);
    try {
      migrateSqliteDatabase(database);
      const before = database.sqlite.prepare("select * from run_content_results").all();
      assert.equal(before.length, 1);
      assert.deepEqual(database.sqlite.prepare("select content_id, summary, score from run_content_results").get(), { content_id: "old-id", summary: "Original summary", score: 73 });
      assert.deepEqual(database.sqlite.prepare("select run_id, outcome, item_count from run_receipts order by run_id").all(), [
        { run_id: "missing-run", outcome: "legacy_incomplete", item_count: 0 },
        { run_id: "old-run", outcome: "legacy_incomplete", item_count: 1 },
      ]);
      assert.equal(database.sqlite.prepare("select * from content_deliveries").all().length, 1);
      assert.equal(database.sqlite.prepare("select * from legacy_content_items").all().length, 1);
      assert.deepEqual(database.sqlite.prepare("select id, schema_version from runtime_events order by sequence").all(), [
        { id: "start", schema_version: 0 }, { id: "claimed-delivery", schema_version: 0 }, { id: "missing-start", schema_version: 0 },
      ]);
      migrateSqliteDatabase(database);
      assert.deepEqual(database.sqlite.prepare("select * from run_content_results").all(), before);
      assert.equal(database.sqlite.prepare("select * from schema_migrations").all().length, 4);
      assert.deepEqual(database.sqlite.pragma("foreign_key_check"), []);
    } finally { database.sqlite.close(); }
  });
}

test("R3.5 failed data migration rolls back schema and old data together", () => {
  const database = oldDatabase(true);
  try {
    database.sqlite.prepare("update content_items set url = ?").run("not-a-url");
    assert.throws(() => migrateSqliteDatabase(database), /Invalid URL/);
    assert.equal(database.sqlite.prepare("select * from content_items").all().length, 1);
    assert.equal(database.sqlite.prepare("select name from sqlite_master where name = 'content_entities'").get(), undefined);
    assert.equal(database.sqlite.prepare("select * from runtime_events").all().length, 3);
  } finally { database.sqlite.close(); }
});

test("R3.5 canonical identity merges retain the original legacy records for recovery", () => {
  const database = oldDatabase(true);
  try {
    database.sqlite.exec("insert into content_items select 'old-fragment-id', run_id, 'Alternate title', source, url || '#section', 'Alternate summary', reason, evidence_json, score, status, created_at from content_items");
    migrateSqliteDatabase(database);
    assert.equal(database.sqlite.prepare("select * from content_entities").all().length, 1);
    assert.equal(database.sqlite.prepare("select * from run_content_results").all().length, 1);
    assert.equal(database.sqlite.prepare("select * from legacy_content_items").all().length, 2);
    assert.deepEqual(database.sqlite.prepare("select summary from legacy_content_items where id = 'old-fragment-id'").get(), { summary: "Alternate summary" });
  } finally { database.sqlite.close(); }
});

test("R3.5 unknown migration versions and changed checksums fail closed", () => {
  const database = createSqliteDatabase();
  try {
    migrateSqliteDatabase(database);
    database.sqlite.prepare("insert into schema_migrations values (5, 'future', 'future', '2026-11-01')").run();
    assert.throws(() => migrateSqliteDatabase(database), /Unsupported/);
    database.sqlite.prepare("delete from schema_migrations where version = 5").run();
    database.sqlite.prepare("update schema_migrations set checksum = 'changed' where version = 2").run();
    assert.throws(() => migrateSqliteDatabase(database), /checksum mismatch/);
  } finally { database.sqlite.close(); }
});
