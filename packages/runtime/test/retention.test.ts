import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteRuntimeStore, type RuntimeEventType } from "../src/index.ts";
import { RuntimeRetention } from "../src/retention.ts";

const old = "2026-10-01T00:00:00.000Z";
const before = "2026-10-02T00:00:00.000Z";
const now = new Date("2026-11-02T00:00:00.000Z");
function event(store: SQLiteRuntimeStore, runId: string, type: RuntimeEventType, payload: Record<string, unknown>, timestamp = old) {
  return store.appendEventSync({ ...store.createEvent(runId, type, payload), timestamp });
}
function run(store: SQLiteRuntimeStore, runId: string, terminal = true, timestamp = old) {
  event(store, runId, "run.started", { title: runId, trigger: "manual" });
  const delta = event(store, runId, "agent.output.delta", { turn: 1, delta: "disposable output" });
  event(store, runId, "agent.tool.completed", { callId: `${runId}-tool`, tool: "fixture", isError: false, result: { evidence: "protected" } });
  if (terminal) event(store, runId, "run.failed", { reason: "fixture" }, timestamp);
  return delta;
}

test("R7 prune deletes only old terminal deltas, bounded before filtering, with idempotent receipt", () => {
  const store = new SQLiteRuntimeStore(); const retention = new RuntimeRetention(store);
  try {
    const pending = run(store, "unfinished", false);
    const oldDelta = run(store, "finished");
    const recent = run(store, "recent", true, "2026-11-01T00:00:00.000Z");
    const protectedBefore = store.database.sqlite.prepare("select * from runtime_events where type <> 'agent.output.delta' order by sequence").all();
    const request = { key: "batch-1", before, maxRows: 1 };
    const first = retention.prune("operator", request, now);
    assert.equal(first.examined, 1); assert.equal(first.deleted, 0);
    assert.ok(first.examinedThrough > 0);
    assert.deepEqual(retention.prune("operator", request, now), first);
    assert.throws(() => retention.prune("operator", { ...request, maxRows: 2 }, now), /different intent/);
    const second = retention.prune("operator", { key: "batch-2", before, afterSequence: first.examinedThrough, maxRows: 2 }, now);
    assert.equal(second.examined, 2); assert.equal(second.deleted, 1);
    assert.equal(store.database.sqlite.prepare("select 1 from runtime_events where id=?").get(oldDelta.id), undefined);
    for (const kept of [pending, recent]) assert.ok(store.database.sqlite.prepare("select 1 from runtime_events where id=?").get(kept.id));
    assert.deepEqual(store.database.sqlite.prepare("select * from runtime_events where type <> 'agent.output.delta' order by sequence").all(), protectedBefore);
    assert.equal(store.readRunDetail("finished")?.run.status, "failed");
    assert.throws(() => retention.prune("operator", { key: "too-many", before, maxRows: 5001 }, now));
    assert.throws(() => retention.prune("operator", { key: "future", before: "2027-01-01T00:00:00Z" }, now), /future/);
  } finally { store.database.sqlite.close(); }
});

test("R7 prune protects open observations, eval references, practice references and job disagreement", () => {
  const store = new SQLiteRuntimeStore(); const retention = new RuntimeRetention(store);
  try {
    run(store, "open-observation", false);
    store.telemetry.start("open-observation", { mode: "live", name: "unfinished tool", details: { kind: "tool", attributes: {} } });
    event(store, "open-observation", "run.failed", { reason: "fixture" });
    const evalDelta = run(store, "eval-reference");
    run(store, "practice-reference"); run(store, "job-disagreement");
    store.database.sqlite.prepare("insert into eval_reports values (?,?,?,?,?,?)").run("eval", "fixture", "passed", 1, JSON.stringify([`Observed event ${evalDelta.id}`]), old);
    store.database.sqlite.prepare("insert into practice_versions values (?,?,?,?,?,?)").run("practice", JSON.stringify({ evidence: [{ runId: "practice-reference" }] }), "fixture", 0, "fixture", old);
    store.database.sqlite.prepare("insert into scheduled_jobs(run_id,scope_key,request_target,trigger,admitted_at,state,reason) values (?,?,?,'manual',?,'queued','fixture')").run("job-disagreement", "fixture", "fixture", old);
    const beforeRows = store.database.sqlite.prepare("select * from runtime_events order by sequence").all();
    const result = retention.prune("operator", { key: "protected", before }, now);
    assert.equal(result.examined, 4); assert.equal(result.deleted, 0);
    assert.deepEqual(store.database.sqlite.prepare("select * from runtime_events order by sequence").all(), beforeRows);
  } finally { store.database.sqlite.close(); }
});

test("R7 prune rolls deletion and audit receipt back together; secrets are not stored in request identity", () => {
  const secret = "synthetic-retention-secret";
  const store = new SQLiteRuntimeStore({ secrets: [secret] }); const retention = new RuntimeRetention(store);
  try {
    const delta = run(store, "rollback");
    store.database.sqlite.exec("create trigger reject_prune before insert on runtime_prunes begin select raise(abort, 'audit write fault'); end");
    const request = { key: secret, before };
    assert.throws(() => retention.prune("operator", request, now), /audit write fault/);
    assert.ok(store.database.sqlite.prepare("select 1 from runtime_events where id=?").get(delta.id));
    assert.equal(store.database.sqlite.prepare("select * from runtime_prunes").all().length, 0);
    store.database.sqlite.exec("drop trigger reject_prune");
    const receipt = retention.prune("operator", request, now);
    assert.equal(receipt.deleted, 1);
    assert.deepEqual(retention.prune("operator", request, now), receipt);
    assert.equal(JSON.stringify(store.database.sqlite.prepare("select * from runtime_prunes").all()).includes(secret), false);
  } finally { store.database.sqlite.close(); }
});
