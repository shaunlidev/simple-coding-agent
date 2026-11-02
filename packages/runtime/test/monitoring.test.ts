import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteRuntimeStore, RuntimeScheduler } from "../src/index.ts";
import { evaluateMonitorConditions, monitoringPolicySchema, type MonitoringOptions } from "../src/monitoring.ts";

function clock() {
  let wall = Date.parse("2026-11-02T00:00:00Z"); let mono = 0;
  const callbacks = new Map<string, () => void>();
  const options: MonitoringOptions = {
    policy: { heartbeatMs: 30, staleMs: 90, pollMs: 5, overdueMs: 15, errorWindowMs: 300 },
    now: () => new Date(wall), monotonic: () => mono,
    repeat: (kind, callback) => { assert.equal(callbacks.has(kind), false); callbacks.set(kind, callback); return () => { callbacks.delete(kind); }; },
  };
  return { options, callbacks, advance(ms: number) { wall += ms; mono += ms; }, rollback(ms: number) { wall -= ms; }, fire(kind: "heartbeat" | "monitor") { callbacks.get(kind)?.(); } };
}
function failedRun(store: SQLiteRuntimeStore, id: string, timestamp: string) {
  store.appendEventSync({ ...store.createEvent(id, "run.started", { title: id, trigger: "manual" }), timestamp });
  store.appendEventSync({ ...store.createEvent(id, "run.failed", { reason: "fixture" }), timestamp });
}
function latch() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("R7 monitoring policy and three-valued conditions reject invented recovery", () => {
  assert.equal(monitoringPolicySchema.parse({}).staleMs, 90_000);
  for (const bad of [{ heartbeatMs: 90_000 }, { pollMs: 15_000 }, { staleMs: 15_000 }, { pollMs: NaN }, { errorThreshold: 0 }]) assert.throws(() => monitoringPolicySchema.parse(bad));
  assert.deepEqual(evaluateMonitorConditions({ heartbeat: "unknown", phase: "draining", failedRuns: null, errorThreshold: 3 }), { heartbeat_stale: "unknown", worker_fault: "unknown", error_burst: "unknown" });
  assert.deepEqual(evaluateMonitorConditions({ heartbeat: "fresh", phase: "faulted", failedRuns: 2, errorThreshold: 3 }), { heartbeat_stale: "inactive", worker_fault: "active", error_burst: "inactive" });
});

for (const path of ["manual", "tick", "start"] as const) test(`R7 ${path} ownership binds one writer and monitor; reads are inert`, async () => {
  const store = new SQLiteRuntimeStore(); const time = clock();
  const worker = new RuntimeScheduler({ runtime: store, monitoring: time.options });
  try {
    assert.equal(worker.monitoring.read().ready, false);
    assert.equal(worker.monitoring.read().worker.heartbeat, "missing");
    if (path === "manual") await worker.runNow(); else if (path === "tick") await worker.tick(); else worker.start();
    await worker.idle();
    assert.equal(worker.monitoring.read().ready, true);
    assert.equal(time.callbacks.size, 2);
    await worker.tick();
    const before = store.database.sqlite.prepare("select * from worker_monitor_state order by id").all();
    for (let i = 0; i < 20; i++) { worker.monitoring.read(); worker.monitoring.alerts(); }
    assert.deepEqual(store.database.sqlite.prepare("select * from worker_monitor_state order by id").all(), before);
    const stopping = worker.stop(); assert.equal(worker.stop(), stopping); await stopping;
    assert.equal(time.callbacks.size, 0);
    assert.equal(worker.monitoring.read().ready, false);
    assert.equal(worker.monitoring.read().worker.phase, "stopped");
  } finally { await worker.stop(); store.database.sqlite.close(); }
});

test("R7 independently detected stale heartbeat recovers freshness, not a faulted owner's dispatch", async () => {
  const store = new SQLiteRuntimeStore(); const time = clock(); const worker = new RuntimeScheduler({ runtime: store, monitoring: time.options });
  const other = new RuntimeScheduler({ runtime: store });
  try {
    await worker.tick();
    for (let i = 0; i < 18; i++) { time.advance(5); time.fire("monitor"); }
    assert.equal(worker.monitoring.read().worker.heartbeat, "stale");
    assert.equal(worker.monitoring.read().ready, false);
    assert.equal(worker.monitoring.alerts().filter((a) => a.condition === "heartbeat_stale" && a.edge === "open").length, 1);
    time.fire("monitor"); time.fire("monitor");
    await assert.rejects(other.tick(), /Another worker/);
    time.fire("heartbeat"); time.fire("monitor");
    assert.equal(worker.monitoring.read().worker.heartbeat, "fresh");
    assert.equal(worker.monitoring.read().worker.phase, "faulted");
    assert.equal(worker.monitoring.read().ready, false);
    await assert.rejects(worker.runNow(), /stopping/);
    assert.deepEqual(worker.monitoring.alerts().filter((a) => a.condition === "heartbeat_stale").map((a) => [a.generation, a.edge]), [[1, "open"], [1, "recovery"]]);
    await worker.stop(); await other.tick();
    assert.equal(other.monitoring.read().ready, true);
    assert.deepEqual(other.monitoring.alerts().filter((a) => a.condition === "worker_fault").map((a) => a.edge), ["open", "recovery"]);
  } finally { await worker.stop(); await other.stop(); store.database.sqlite.close(); }
});

test("R7 monitor overdue and backwards wall clock cannot appear ready between timer ticks", async () => {
  for (const fault of ["overdue", "clock"] as const) {
    const store = new SQLiteRuntimeStore(); const time = clock(); const worker = new RuntimeScheduler({ runtime: store, monitoring: time.options });
    try {
      await worker.tick();
      if (fault === "overdue") time.advance(15); else time.rollback(1);
      assert.equal(worker.monitoring.read().ready, false);
      assert.equal(worker.monitoring.read().worker.heartbeat, fault === "clock" ? "unknown" : "fresh");
      await assert.rejects(worker.runNow(), /not ready/);
      assert.equal(worker.listJobs().length, 0);
      if (fault === "clock") time.advance(1);
    } finally { await worker.stop(); store.database.sqlite.close(); }
  }
});

test("R7 error bursts count distinct failed runs and atomically deduplicate window recovery", async () => {
  const store = new SQLiteRuntimeStore(); const time = clock(); const worker = new RuntimeScheduler({ runtime: store, monitoring: time.options });
  try {
    await worker.tick();
    for (let i = 0; i < 3; i++) failedRun(store, `failed-${i}`, time.options.now!().toISOString());
    store.database.sqlite.exec("create trigger reject_alert before insert on worker_alert_transitions begin select raise(abort, 'secret-fixture-poll-failure'); end");
    time.fire("monitor");
    assert.equal(worker.monitoring.read().worker.phase, "faulted");
    assert.equal(store.database.sqlite.prepare("select * from worker_alert_state").all().length, 0);
    assert.deepEqual(worker.monitoring.alerts(), []);
    store.database.sqlite.exec("drop trigger reject_alert");
    time.fire("monitor"); time.fire("monitor");
    const opened = worker.monitoring.alerts().filter((a) => a.condition === "error_burst");
    assert.equal(opened.length, 1); assert.equal(opened[0].evidence.failedRuns, 3);
    assert.equal(opened[0].evidence.source, "runtime"); assert.equal(opened[0].evidence.severity, "warning");
    assert.deepEqual(opened[0].evidence.runIds, ["failed-2", "failed-1", "failed-0"]);
    assert.equal(opened[0].evidence.sampleTruncated, false);
    assert.equal(opened[0].evidence.ruleVersion, 1); assert.ok(opened[0].evidence.watermark > 0);
    for (let i = 0; i < 60; i++) { time.advance(5); time.fire("heartbeat"); time.fire("monitor"); }
    assert.deepEqual(worker.monitoring.alerts().filter((a) => a.condition === "error_burst").map((a) => a.edge), ["open", "recovery"]);
    assert.equal(JSON.stringify(worker.monitoring.alerts()).includes("secret-fixture"), false);
  } finally { await worker.stop(); store.database.sqlite.close(); }
});

test("R7 heartbeat write failure aborts and retains ownership until active cleanup drains", { timeout: 5000 }, async () => {
  const store = new SQLiteRuntimeStore(); const time = clock(); const aborted = latch(); const cleanup = latch();
  const worker = new RuntimeScheduler({ runtime: store, monitoring: time.options, runAgent: async ({ signal }) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.release(); resolve(); }, { once: true }));
    await cleanup.promise; signal.throwIfAborted(); return "unreachable";
  } });
  const other = new RuntimeScheduler({ runtime: store });
  try {
    const runId = await worker.runNow();
    store.database.sqlite.exec("create trigger reject_heartbeat before update on worker_monitor_state when new.id='worker' begin select raise(abort, 'secret-fixture-write-failure'); end");
    time.fire("heartbeat"); await aborted.promise;
    time.fire("monitor");
    const alert = worker.monitoring.alerts().find((entry) => entry.condition === "worker_fault");
    assert.deepEqual(alert?.evidence.runIds, [runId]);
    assert.equal(alert?.evidence.source, "worker"); assert.equal(alert?.evidence.severity, "critical");
    assert.equal(worker.monitoring.read().worker.phase, "faulted");
    await assert.rejects(other.tick(), /Another worker/);
    store.database.sqlite.exec("drop trigger reject_heartbeat");
    const stop = worker.stop();
    await assert.rejects(other.tick(), /Another worker/);
    cleanup.release(); await stop; await other.tick();
    assert.equal(time.callbacks.size, 0);
  } finally { cleanup.release(); await worker.stop(); await other.stop(); store.database.sqlite.close(); }
});

test("R7 error alert run evidence is bounded and reports truncation", async () => {
  const store = new SQLiteRuntimeStore(); const time = clock(); const worker = new RuntimeScheduler({ runtime: store, monitoring: time.options });
  try {
    await worker.tick();
    for (let i = 0; i < 22; i++) failedRun(store, `run-${i}`, time.options.now!().toISOString());
    time.fire("monitor");
    const alert = worker.monitoring.alerts().find((entry) => entry.condition === "error_burst");
    assert.equal(alert?.evidence.failedRuns, 22); assert.equal(alert?.evidence.runIds.length, 20);
    assert.equal(alert?.evidence.sampleTruncated, true);
    assert.deepEqual(alert?.evidence.runIds, Array.from({ length: 20 }, (_, i) => `run-${21 - i}`));
  } finally { await worker.stop(); store.database.sqlite.close(); }
});

test("R7 failed terminal persistence fences before finally can dispatch a queued run", { timeout: 5000 }, async () => {
  const store = new SQLiteRuntimeStore(); const time = clock(); const finish = latch(); const calls: string[] = [];
  const worker = new RuntimeScheduler({ runtime: store, monitoring: time.options, runAgent: async ({ runId }) => { calls.push(runId); await finish.promise; throw new Error("expected executor failure"); } });
  try {
    const first = await worker.runNow(); const second = await worker.runNow();
    store.database.sqlite.exec("create trigger reject_terminal before insert on runtime_events when new.type='run.failed' begin select raise(abort, 'terminal write fault'); end");
    const idle = worker.idle(); finish.release();
    await assert.rejects(idle, /terminal write fault/);
    assert.deepEqual(calls, [first]); assert.equal(store.readRunDetail(second)?.run.status, "queued");
    assert.equal(worker.monitoring.read().worker.phase, "faulted");
    store.database.sqlite.exec("drop trigger reject_terminal");
  } finally { finish.release(); await worker.stop(); store.database.sqlite.close(); }
});

test("R7 monitor setup failure disposes earlier timers and releases an unused owner", async () => {
  const store = new SQLiteRuntimeStore(); let disposed = false;
  const worker = new RuntimeScheduler({ runtime: store, monitoring: { repeat: (kind) => { if (kind === "monitor") throw new Error("timer setup fault"); return () => { disposed = true; }; } } });
  const other = new RuntimeScheduler({ runtime: store });
  try { await assert.rejects(worker.tick(), /timer setup fault/); assert.equal(disposed, true); await other.tick(); }
  finally { await worker.stop(); await other.stop(); store.database.sqlite.close(); }
});

test("R7 closed storage produces unavailable health, not a healthy worker", async () => {
  const store = new SQLiteRuntimeStore(); const worker = new RuntimeScheduler({ runtime: store });
  await worker.tick(); store.database.sqlite.close();
  assert.equal(worker.monitoring.read().ready, false); assert.equal(worker.monitoring.read().database, "unavailable");
  await worker.stop();
});
