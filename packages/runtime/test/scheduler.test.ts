import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeScheduler, SQLiteRuntimeStore, type RuntimeSchedule } from "../src/index.ts";

const at = new Date("2026-11-01T00:00:00Z");
const schedule = (id = "schedule", policy: RuntimeSchedule["overlapPolicy"] = "queue"): RuntimeSchedule => ({ id, title: "Test schedule", cron: "@every 1h", timezone: "Asia/Shanghai", enabled: true, nextRunAt: at.toISOString(), overlapPolicy: policy });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function latch() { let release = () => {}; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("R5.2 queue preserves every run in FIFO order; retries and skip do not execute twice", async () => {
  const store = new SQLiteRuntimeStore();
  const started: string[] = []; const gates = new Map<string, ReturnType<typeof latch>>();
  const worker = new RuntimeScheduler({ runtime: store, now: () => at, runAgent: async ({ runId }) => {
    started.push(runId); const gate = latch(); gates.set(runId, gate); await gate.promise;
    store.commitContentRun({ runId, items: [], maxItems: 0 }); return runId;
  } });
  try {
    await store.createSchedule(schedule());
    const ids = [];
    for (const key of ["first", "second", "third"]) ids.push(await worker.runNow("schedule", { actor: "owner", key }));
    assert.deepEqual(started, [ids[0]]);
    assert.equal(await worker.runNow("schedule", { actor: "owner", key: "second" }), ids[1]);
    assert.equal(worker.listJobs().length, 3);
    assert.equal(store.telemetry.operations(ids[1]).filter(({ start }) => start.details.kind === "scheduler").length, 1);
    assert.ok(store.telemetry.operations(ids[1]).find(({ start }) => start.details.kind === "scheduler")?.completion);
    for (const id of ids) { gates.get(id)?.release(); await turn(); }
    await worker.idle();
    assert.deepEqual(started, ids);
    assert.ok(worker.listJobs().every((job) => job.state === "completed"));
    assert.equal(store.readSchedulesSync()[0]?.nextRunAt, at.toISOString(), "manual work must not advance cron");
  } finally { for (const gate of gates.values()) gate.release(); await worker.stop(); store.database.sqlite.close(); }
});

test("R5.2 cancellation fences delivery and waits for teardown before replacing execution", async () => {
  const store = new SQLiteRuntimeStore(); const cleanup = latch(); const aborted = latch(); const calls: string[] = [];
  const worker = new RuntimeScheduler({ runtime: store, runAgent: async ({ runId, signal }) => {
    calls.push(runId);
    if (calls.length === 1) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.release(); resolve(); }, { once: true }));
      await cleanup.promise;
      signal.throwIfAborted();
    }
    store.commitContentRun({ runId, items: [], maxItems: 0 }); return runId;
  } });
  try {
    await store.createSchedule(schedule("schedule", "cancel_previous"));
    const first = await worker.runNow("schedule");
    const replacement = await worker.runNow("schedule");
    await aborted.promise;
    assert.equal(store.readRunDetail(first)?.run.status, "cancelling");
    assert.deepEqual(calls, [first]);
    assert.equal(store.readRunDetail(replacement)?.run.status, "queued");
    assert.throws(() => store.commitContentRun({ runId: first, items: [], maxItems: 0 }), /cancel/);
    await assert.rejects(() => store.appendEvent(store.createEvent(first, "pipeline.clean.completed", { count: 1 })), /cancel/);
    cleanup.release(); await worker.idle();
    assert.deepEqual(calls, [first, replacement]);
    assert.equal(store.readRunDetail(first)?.run.status, "cancelled");
    assert.equal(store.readRunResult(first), undefined);
    assert.equal(store.readRunDetail(replacement)?.run.status, "completed");
  } finally { cleanup.release(); await worker.stop(); store.database.sqlite.close(); }
});

test("R5.3 due admission and cursor advance roll back together; missed triggers coalesce once", async () => {
  const store = new SQLiteRuntimeStore(); const worker = new RuntimeScheduler({ runtime: store, now: () => at });
  try {
    await store.createSchedule(schedule());
    store.database.sqlite.exec("create trigger reject_job before insert on scheduled_jobs begin select raise(abort, 'injected queue failure'); end");
    await assert.rejects(() => worker.tick(new Date("2026-11-01T06:30:00Z")), /injected queue failure/);
    assert.equal((await store.listRuns()).length, 0);
    assert.equal(store.readSchedulesSync()[0]?.nextRunAt, at.toISOString());
    store.database.sqlite.exec("drop trigger reject_job");
    const result = await worker.tick(new Date("2026-11-01T06:30:00Z"));
    assert.equal(result.length, 1);
    assert.equal(worker.listJobs().length, 1);
    assert.equal(store.readSchedulesSync()[0]?.nextRunAt, "2026-11-01T07:00:00.000Z");
    assert.equal((await store.listEvents()).find((event) => event.payload.occurrenceCount)?.payload.occurrenceCount, 7);
    assert.deepEqual(await worker.tick(new Date("2026-11-01T06:30:00Z")), []);
  } finally { await worker.stop(); store.database.sqlite.close(); }
});

test("R7 shutdown persistence failure still aborts, drains and only then releases ownership", { timeout: 5000 }, async () => {
  const store = new SQLiteRuntimeStore(); const aborted = latch(); const cleanup = latch();
  const worker = new RuntimeScheduler({ runtime: store, runAgent: async ({ signal }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.release(); resolve(); }, { once: true }));
    await cleanup.promise;
    signal.throwIfAborted();
    return "unreachable";
  } });
  const other = new RuntimeScheduler({ runtime: store });
  let shutdown: Promise<void> | undefined;
  try {
    await worker.runNow();
    store.database.sqlite.exec("create trigger fail_cancel before insert on runtime_events when new.type='run.cancel_requested' begin select raise(abort, 'cancel write fault'); end");
    shutdown = worker.stop();
    const observed = shutdown.catch((error: unknown) => error);
    await aborted.promise;
    await assert.rejects(other.tick(), /Another worker/);
    cleanup.release();
    const failure = await observed;
    assert.ok(failure instanceof AggregateError);
    assert.match(String(failure.cause), /cancel write fault/);
    await other.tick();
    assert.equal(other.listJobs()[0].state, "failed");
  } finally {
    cleanup.release(); await shutdown?.catch(() => undefined); await worker.stop().catch(() => undefined); await other.stop(); store.database.sqlite.close();
  }
});

test("R5.3 a second worker is refused; graceful restart retains queued snapshots/order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "r5-worker-")); const path = join(directory, "runtime.sqlite");
  const firstStore = new SQLiteRuntimeStore({ path }); const secondStore = new SQLiteRuntimeStore({ path });
  const first = new RuntimeScheduler({ runtime: firstStore, runAgent: async ({ signal }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); return "unreachable";
  } });
  const second = new RuntimeScheduler({ runtime: secondStore });
  try {
    await firstStore.createSchedule(schedule());
    const running = await first.runNow("schedule"); const queued = await first.runNow("schedule");
    await assert.rejects(() => second.tick(at), /Another worker/);
    await first.stop();
    assert.equal(firstStore.readRunDetail(running)?.run.status, "cancelled");
    assert.equal(firstStore.readRunDetail(queued)?.run.status, "queued");
    await second.tick(new Date("2026-10-31T00:00:00Z"));
    assert.equal(secondStore.readRunDetail(queued)?.run.status, "completed");
    assert.equal(second.listJobs().length, 2);
  } finally { await first.stop(); await second.stop(); firstStore.database.sqlite.close(); secondStore.database.sqlite.close(); await rm(directory, { recursive: true, force: true }); }
});

test("R5.4 pause/resume skips the paused window; manual work is still explicit", async () => {
  const store = new SQLiteRuntimeStore(); const worker = new RuntimeScheduler({ runtime: store, now: () => at });
  try {
    await store.createSchedule({ ...schedule(), enabled: false });
    assert.deepEqual(await worker.tick(at), []);
    const runId = await worker.runNow("schedule");
    assert.equal(store.readRunDetail(runId)?.run.trigger, "manual");
    assert.equal(store.readSchedulesSync()[0]?.nextRunAt, at.toISOString());
    const resumed = await store.updateSchedule("schedule", { enabled: true }, new Date("2026-11-01T05:15:00Z"));
    assert.equal(resumed.nextRunAt, "2026-11-01T06:00:00.000Z");
    assert.deepEqual(await worker.tick(new Date("2026-11-01T05:15:00Z")), []);
  } finally { await worker.stop(); store.database.sqlite.close(); }
});

test("R5.2 task overlap includes manual queued work; a cancelled queue entry never starts", async () => {
  const store = new SQLiteRuntimeStore(); const barrier = latch(); const started: string[] = [];
  const worker = new RuntimeScheduler({ runtime: store, runAgent: async ({ runId }) => {
    started.push(runId); if (started.length === 1) await barrier.promise;
    await store.appendEvent(store.createEvent(runId, "run.failed", { reason: "controlled_executor_end" })); return runId;
  } });
  try {
    for (const id of ["a", "b"]) store.saveContentTask({ id, title: id, instruction: "Read source", model: "fixture", sources: [{ id: "source", kind: "url", url: "https://source.test/page" }] }, 0);
    await store.createSchedule({ ...schedule("scheduled-a", "skip"), taskId: "a" });
    const b = await worker.runTask("b", { actor: "owner", key: "b" });
    const a = await worker.runTask("a", { actor: "owner", key: "a" });
    await assert.rejects(() => worker.runNow("scheduled-a"), /overlap_skip/);
    assert.equal(started.length, 1);
    await store.updateSchedule("scheduled-a", { overlapPolicy: "cancel_previous" });
    const replacement = await worker.runNow("scheduled-a", { actor: "owner", key: "replacement" });
    assert.equal(store.readRunDetail(a)?.run.status, "cancelled");
    await store.updateSchedule("scheduled-a", { taskId: "b" });
    assert.equal(await worker.runNow("scheduled-a", { actor: "owner", key: "replacement" }), replacement, "retry preserves frozen original target");
    await assert.rejects(() => worker.runTask("b", { actor: "owner", key: "replacement" }), /different intent/);
    barrier.release(); await worker.idle();
    assert.deepEqual(started, [b, replacement]);
  } finally { barrier.release(); await worker.stop(); store.database.sqlite.close(); }
});

test("R5.3 refusing an in-memory worker does not release the actual owner's lock", async () => {
  const store = new SQLiteRuntimeStore(); const first = new RuntimeScheduler({ runtime: store }); const second = new RuntimeScheduler({ runtime: store }); const third = new RuntimeScheduler({ runtime: store });
  try {
    await first.tick(at);
    await assert.rejects(() => second.tick(at), /Another worker/); await second.stop();
    await assert.rejects(() => third.tick(at), /Another worker/);
  } finally { await first.stop(); await third.stop(); store.database.sqlite.close(); }
});

test("R5.3 upgrading legacy request history preserves terminal retries and frozen queued work", async () => {
  const store = new SQLiteRuntimeStore();
  const task = store.saveContentTask({ id: "task", title: "Original", instruction: "Read source", model: "fixture", sources: [{ id: "source", kind: "url", url: "https://source.test/page" }] }, 0);
  const completed = store.admitContentRun({ actor: "owner", key: "old-completed", taskId: "task", trigger: "manual" });
  await store.appendEvent(store.createEvent(completed.runId, "run.failed", { reason: "original_failure" }));
  const queued = store.admitContentRun({ actor: "owner", key: "old-queued", taskId: "task", trigger: "manual" });
  store.saveContentTask({ ...task.definition, title: "Edited later" }, 1);
  const started: string[] = [];
  const worker = new RuntimeScheduler({ runtime: store, runAgent: async ({ runId }) => {
    started.push(runId); await store.appendEvent(store.createEvent(runId, "run.failed", { reason: "controlled_end" })); return runId;
  } });
  try {
    assert.equal(await worker.runTask("task", { actor: "owner", key: "old-completed" }), completed.runId);
    await worker.idle();
    assert.deepEqual(started, [queued.runId]);
    assert.equal(store.readRunTask(queued.runId)?.definition.title, "Original");
    assert.equal(worker.listJobs().length, 2);
  } finally { await worker.stop(); store.database.sqlite.close(); }
});

test("R5.4 real node-cron polling triggers, pauses and resumes without a manual tick", { timeout: 10000 }, async () => {
  const store = new SQLiteRuntimeStore(); const first = latch(); const second = latch(); let calls = 0;
  const worker = new RuntimeScheduler({ runtime: store, runAgent: async ({ runId }) => {
    calls++; store.commitContentRun({ runId, items: [], maxItems: 0 });
    if (calls === 1) first.release(); else second.release();
    return runId;
  } });
  try {
    await store.createSchedule({ ...schedule("automatic", "skip"), cron: "@every 1s", nextRunAt: new Date().toISOString() });
    worker.start(); await first.promise;
    await store.updateSchedule("automatic", { enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls, 1);
    const resumed = await store.updateSchedule("automatic", { enabled: true });
    assert.ok(new Date(resumed.nextRunAt) > new Date());
    await second.promise; await worker.stop();
    assert.equal(calls, 2);
    assert.equal(store.readSchedulesSync()[0]?.lastTrigger, "schedule");
    assert.ok(worker.listJobs().every((job) => job.trigger === "schedule" && job.state === "completed" && job.scheduled_for));
  } finally { await worker.stop(); store.database.sqlite.close(); }
});
