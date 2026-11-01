import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContentPipeline, SQLiteRuntimeStore } from "../src/index.ts";

test("R3.1 repeated runs retain their own results and deliver the content only once", async () => {
  const store = new SQLiteRuntimeStore();
  const sources = [{ id: "fixture", kind: "mock" as const, items: [{ title: "Agent delivery contracts", source: "fixture", url: "https://example.test/one", text: "A sufficiently detailed article about reliable agent event delivery and consistency." }] }];
  try {
    for (const runId of ["first", "second", "third"]) {
      await store.appendEvent(store.createEvent(runId, "run.started", { title: runId, trigger: "manual" }));
      await runContentPipeline(store, runId, { sources });
      const items = await store.listContentItems(runId);
      assert.equal(items.length, 1, `${runId} must keep its result`);
      assert.equal(items.filter((item) => item.status === "delivered").length, runId === "first" ? 1 : 0);
      const result = store.readRunResult(runId);
      assert.equal(result?.outcome, runId === "first" ? "delivered" : "no_new_items");
      assert.equal(result?.deliveredCount, result?.deliveries.length);
      assert.equal(Boolean(result?.digest), runId === "first");
    }
    const events = await store.listEvents();
    assert.equal(events.filter((event) => event.type === "delivery.created").length, 1);
    assert.equal((await store.listContentItems("first"))[0]?.status, "delivered");
  } finally { store.database.sqlite.close(); }
});

test("R3 reads do not seed demo runs or schedules", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    const changes = () => store.database.sqlite.prepare("select total_changes() as count").get();
    const before = changes();
    const snapshot = await store.snapshot();
    assert.equal(snapshot.latestRun, undefined);
    assert.deepEqual(snapshot.events, []);
    assert.deepEqual(snapshot.schedules, []);
    assert.deepEqual(changes(), before);
  } finally { store.database.sqlite.close(); }
});

test("R3.4 malformed timestamps and event payloads cannot be persisted", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    const event = store.createEvent("validation", "run.started", { title: "Validation", trigger: "manual" });
    await assert.rejects(store.appendEvent({ ...event, timestamp: "yesterday" }));
    await assert.rejects(store.appendEvent({ ...event, payload: { title: ["wrong"], trigger: "invalid" } }));
    await assert.rejects(store.appendEvent({ ...event, type: "made.up" }));
    await assert.rejects(store.appendEvent({ ...event, schemaVersion: 99 }));
    assert.deepEqual(await store.listEvents(), []);
  } finally { store.database.sqlite.close(); }
});

test("R3.1 delivery transaction rolls back results, ledger, receipt and success events together", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    await store.appendEvent(store.createEvent("atomic", "run.started", { title: "Atomic", trigger: "manual" }));
    const input = { runId: "atomic", maxItems: 1, items: [{ id: "candidate", runId: "atomic", title: "Atomic delivery", source: "fixture", summary: "Transaction evidence", reason: "Relevant", score: 70, status: "delivered" as const, evidence: ["fixture"], createdAt: new Date().toISOString() }] };
    store.database.sqlite.exec("create trigger fail_delivery before insert on content_deliveries begin select raise(abort, 'injected delivery failure'); end");
    assert.throws(() => store.commitContentRun(input), /injected delivery failure/);
    for (const table of ["content_entities", "run_content_results", "content_deliveries", "run_receipts"]) assert.equal(store.database.sqlite.prepare(`select * from ${table}`).all().length, 0, table);
    assert.deepEqual((await store.listEvents("atomic")).map((event) => event.type), ["run.started"]);
    store.database.sqlite.exec("drop trigger fail_delivery");
    const result = store.commitContentRun(input);
    assert.equal(result.deliveries.length, 1);
    assert.deepEqual(store.commitContentRun(input), result);
    assert.throws(() => store.commitContentRun({ ...input, maxItems: 2 }), /different input/);
    assert.equal((await store.listEvents("atomic")).filter((event) => event.type === "delivery.created").length, 1);
  } finally { store.database.sqlite.close(); }
});

test("R3.1 delivery limit is applied after already-delivered candidates", async () => {
  const store = new SQLiteRuntimeStore();
  const sources = [{ id: "fixture", kind: "mock" as const, items: [
    { title: "First article", source: "fixture", url: "https://example.test/first", text: "Detailed reasoning about agent consistency contracts and durable execution." },
    { title: "Second article", source: "fixture", url: "https://example.test/second", text: "Database migrations preserve historical entries through carefully designed transformation steps." },
  ] }];
  try {
    await runContentPipeline(store, "limit-one", { sources, maxItems: 1 });
    await runContentPipeline(store, "limit-two", { sources, maxItems: 1 });
    const first = store.readRunResult("limit-one");
    const second = store.readRunResult("limit-two");
    assert.equal(first?.items.length, 2);
    assert.equal(second?.items.length, 2);
    assert.equal(first?.deliveries.length, 1);
    assert.equal(second?.deliveries.length, 1);
    assert.notEqual(first?.deliveries[0]?.contentId, second?.deliveries[0]?.contentId);
    assert.equal(second?.items[0]?.status, "already_delivered");
  } finally { store.database.sqlite.close(); }
});

test("R3 successful empty source is no_new_items, not a fetch failure", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    assert.deepEqual(await runContentPipeline(store, "empty", { sources: [{ id: "empty", kind: "mock", items: [] }] }), []);
    assert.equal(store.readRunResult("empty")?.outcome, "no_new_items");
    assert.equal((await store.projectRun("empty")).status, "completed");
  } finally { store.database.sqlite.close(); }
});

test("R3.4 file restart preserves results and event insertion order; terminal states reject late commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-r3-replay-"));
  const path = join(directory, "state.sqlite");
  let store = new SQLiteRuntimeStore({ path });
  try {
    await runContentPipeline(store, "persisted");
    const original = store.readRunResult("persisted");
    const admitted = store.admitRun({ actor: "owner", key: "cancel-key", intent: { taskId: "task", title: "Cancelled", trigger: "manual" } });
    assert.equal((await store.projectRun(admitted.runId)).status, "queued");
    const started = { ...store.createEvent(admitted.runId, "run.started", { title: "Cancelled", trigger: "manual" }), timestamp: "2026-11-01T10:00:00Z" };
    await store.appendEvent(started);
    await store.appendEvent(started);
    await assert.rejects(store.appendEvent({ ...started, payload: { title: "Changed" } }), /reused/);
    await store.appendEvent({ ...store.createEvent(admitted.runId, "run.cancelled", { reason: "user_request" }), timestamp: "2026-11-01T09:00:00Z" });
    assert.throws(() => store.commitContentRun({ runId: admitted.runId, items: [], maxItems: 5 }), /not accepting/);
    store.database.sqlite.close();
    store = new SQLiteRuntimeStore({ path });
    assert.deepEqual(store.readRunResult("persisted"), original);
    assert.equal((await store.projectRun("persisted")).status, "completed");
    assert.equal((await store.projectRun(admitted.runId)).status, "cancelled");
    assert.deepEqual((await store.listEvents(admitted.runId)).map((event) => event.type), ["run.queued", "run.started", "run.cancelled"]);
    assert.deepEqual(store.admitRun({ actor: "owner", key: "cancel-key", intent: { taskId: "task", title: "Cancelled", trigger: "manual" } }), { runId: admitted.runId, created: false });
  } finally { store.database.sqlite.close(); await rm(directory, { recursive: true, force: true }); }
});
