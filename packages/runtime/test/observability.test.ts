import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteRuntimeStore } from "../src/index.ts";
import { freezePrice } from "../src/pricing.ts";
import { latency } from "../src/observability.ts";

const now = new Date("2026-11-02T12:00:00.000Z");
const at = "2026-11-02T11:00:00.000Z";
const rate = { version: "fixture-v1", provider: "fixture", model: "model", source: "https://example.test/prices", checkedAt: at, validFrom: "2026-11-01T00:00:00.000Z", validUntil: "2026-12-01T00:00:00.000Z", inputMicrousdPerMillion: 1_000_000, cachedInputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 2_000_000 };
function admitted(store: SQLiteRuntimeStore, id: string, mode: "live" | "demo" = "live", timestamp = at) {
  store.appendEventSync({ ...store.createEvent(id, "run.started", { title: id, trigger: "manual" }), timestamp });
  store.telemetry.context(id, mode);
}
function finish(store: SQLiteRuntimeStore, id: string, durationMs: number, timestamp = at) {
  store.appendEventSync({ ...store.createEvent(id, "run.completed", { durationMs }), timestamp });
}

test("R7 empty and legacy history do not imply successful checks, zero usage or latency samples", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    const empty = await store.snapshot(now);
    assert.deepEqual(empty.evals, []);
    assert.deepEqual(empty.security.denials, []);
    assert.equal(empty.security.secretScan, "not_run");
    assert.equal(empty.security.sandbox, "not_configured");
    assert.equal(empty.metrics.successRate, null);
    assert.equal(empty.metrics.evalPassRate, null);
    assert.equal(empty.metrics.costUsd, null);
    assert.equal(empty.metrics.runLatency.samples, 0);
    assert.equal(empty.metrics.runLatency.p95Ms, null);
    store.appendEventSync(store.createEvent("legacy", "run.started", { title: "Uninstrumented", trigger: "manual" }));
    store.appendEventSync(store.createEvent("legacy", "pipeline.summarize.completed", { count: 1, inputTokens: 2380, costUsd: 0.0029 }));
    assert.equal((await store.projectRun("legacy")).costUsd, null);
    assert.equal((await store.projectRun("legacy")).accounting.costStatus, "unknown");
    assert.deepEqual(store.readTrace("legacy")?.spans, []);
  } finally { store.database.sqlite.close(); }
});

test("R7 nearest-rank metrics separate populations, measured zero, demo and time window", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    for (const [index, duration] of [0, 10, 20, 100].entries()) {
      const id = `run-${index}`; admitted(store, id);
      if (index < 3) {
        const operation = store.telemetry.start(id, { mode: "live", name: "tool", startedAt: at, details: { kind: "tool", attributes: {} } });
        store.telemetry.complete(id, { operationId: operation.operationId, result: { state: "finished", outcome: index === 2 ? "error" : "ok", endedAt: at, durationMs: [1, 3, 7][index] }, usage: { kind: "not_applicable" }, responseModel: null });
      }
      finish(store, id, duration);
    }
    admitted(store, "old", "live", "2026-10-30T00:00:00.000Z"); finish(store, "old", 9999, "2026-10-30T00:00:00.000Z");
    admitted(store, "demo", "demo"); finish(store, "demo", 8888);
    admitted(store, "unknown-duration"); store.appendEventSync({ ...store.createEvent("unknown-duration", "run.failed", { reason: "unmeasured" }), timestamp: at });
    const { metrics } = await store.snapshot(now);
    assert.deepEqual(metrics.runLatency, { samples: 4, p50Ms: 10, p95Ms: 100, method: "nearest_rank" });
    assert.deepEqual(metrics.toolLatency, { samples: 3, p50Ms: 3, p95Ms: 7, method: "nearest_rank" });
    assert.equal(metrics.modelLatency.samples, 0);
    assert.equal(metrics.toolFailures, 1);
    assert.equal(metrics.terminalRuns, 5);
    assert.equal(metrics.successRate, 4 / 5);
    assert.equal(metrics.errorRate, 1 / 5);
    assert.equal(latency([]).p50Ms, null);
  } finally { store.database.sqlite.close(); }
});

test("R7 partial cost and usage do not masquerade as complete totals, export never invents end times", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    admitted(store, "run");
    const details = { kind: "llm" as const, provider: "fixture", model: "model", turn: 1, billing: "paid" as const, price: freezePrice([rate], { provider: "fixture", model: "model", at }), reservation: { kind: "unknown" as const, reason: "fixture" } };
    const first = store.telemetry.start("run", { mode: "live", startedAt: at, name: "model", details });
    store.telemetry.complete("run", { operationId: first.operationId, result: { state: "finished", outcome: "ok", endedAt: at, durationMs: 0 }, usage: { kind: "reported", value: { input: 100, output: 20, totalTokens: 120, cacheReadInput: 30 } }, responseModel: "model" });
    store.telemetry.start("run", { mode: "live", startedAt: at, name: "pending model", details: { ...details, turn: 2 } });
    const run = await store.projectRun("run");
    assert.equal(run.costUsd, null); assert.equal(run.inputTokens, null);
    assert.equal(run.accounting.costStatus, "partial"); assert.equal(run.accounting.usageStatus, "partial");
    assert.equal(run.accounting.knownCostUsd, 0.000113);
    assert.equal(run.accounting.unknownCostCalls, 1);
    const { metrics } = await store.snapshot(now);
    assert.equal(metrics.accounting.costStatus, "partial"); assert.equal(metrics.costUsd, null);
    const trace = store.readTrace("run");
    assert.ok(trace);
    assert.equal(trace.spans.length, 3);
    assert.equal(trace.omittedFromOtlp.length, 2);
    const exported = trace.otlp.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(exported.length, 1);
    assert.equal(exported[0].spanId, first.spanId);
    assert.equal(exported[0].parentSpanId, store.telemetry.readContext("run")?.rootSpanId);
    assert.match(exported[0].traceId, /^[0-9a-f]{32}$/);
    assert.equal(exported[0].startTimeUnixNano, "1793617200000000000");
    assert.equal(trace.spans.find((span) => span.name === "pending model")?.durationMs, null);
  } finally { store.database.sqlite.close(); }
});

test("R7 executing run remains visible when a newer run is queued", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    admitted(store, "active");
    store.appendEventSync(store.createEvent("queued", "run.queued", { title: "Next", taskId: "task", trigger: "manual" }));
    const snapshot = await store.snapshot(now);
    assert.equal(snapshot.latestRun?.id, "active");
    assert.equal(snapshot.agent.status, "running");
  } finally { store.database.sqlite.close(); }
});
