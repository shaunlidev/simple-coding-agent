import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteRuntimeStore } from "../src/index.ts";
import { freezePrice, estimateCallReservation } from "../src/pricing.ts";
import type { ObservationIntent } from "../src/telemetry.ts";

const at = "2026-11-02T00:00:00.000Z";
const rate = { version: "fixture-v1", provider: "fixture", model: "model", source: "https://example.test/prices", checkedAt: at, validFrom: at, validUntil: "2026-12-01T00:00:00.000Z", inputMicrousdPerMillion: 1_000_000, cachedInputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 2_000_000 };
const price = freezePrice([rate], { provider: "fixture", model: "model", at });
const details = { kind: "llm" as const, provider: "fixture", model: "model", turn: 1, billing: "paid" as const, price, reservation: estimateCallReservation(price, { inputTokens: 100, maxOutputTokens: 20 }) };
function admit(store: SQLiteRuntimeStore, runId = "run") {
  store.appendEventSync(store.createEvent(runId, "run.started", { title: "Telemetry fixture", trigger: "manual" }));
}
function start(store: SQLiteRuntimeStore, runId = "run") {
  return store.telemetry.start(runId, { mode: "live", name: "chat model", startedAt: at, details });
}
function intent(operationId: string): ObservationIntent {
  return { operationId, result: { state: "finished", outcome: "ok", endedAt: "2026-11-02T00:00:00.020Z", durationMs: 20 }, usage: { kind: "reported", value: { input: 100, output: 20, totalTokens: 120, cacheReadInput: 30, cacheMissInput: 70 } }, responseModel: "model" };
}

test("R7 facts persist nonzero trace IDs, parents and immutable historical cost across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "r7-facts-"));
  const path = join(root, "runtime.sqlite");
  let store = new SQLiteRuntimeStore({ path });
  try {
    admit(store);
    const first = start(store);
    assert.match(first.traceId, /^[0-9a-f]{32}$/);
    assert.match(first.spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(first.spanId, "0".repeat(16));
    const child = store.telemetry.start("run", { mode: "live", name: "child", details: { kind: "source", attributes: {} }, parentSpanId: first.spanId });
    assert.equal(child.traceId, first.traceId);
    assert.equal(child.parentSpanId, first.spanId);
    const settled = store.telemetry.complete("run", intent(first.operationId));
    assert.ok(settled.cost.kind === "estimated" && settled.cost.nanoUsd === 113_000);
    const context = store.telemetry.readContext("run");
    store.database.sqlite.close();
    store = new SQLiteRuntimeStore({ path });
    assert.deepEqual(store.telemetry.context("run", "live"), context);
    assert.deepEqual(store.telemetry.operations("run")[0].completion, settled);
    assert.deepEqual(store.telemetry.complete("run", intent(first.operationId)), settled);
    assert.throws(() => store.telemetry.complete("run", { ...intent(first.operationId), responseModel: "another" }), /Conflicting/);
    assert.throws(() => store.telemetry.context("run", "demo"), /mode/);
  } finally { store.database.sqlite.close(); rmSync(root, { recursive: true, force: true }); }
});

test("R7 facts reject unadmitted calls, cross-run parents, forged prices and forged settlements", () => {
  const store = new SQLiteRuntimeStore();
  try {
    assert.throws(() => start(store), /admitted/);
    admit(store); admit(store, "other");
    const operation = start(store);
    assert.throws(() => store.telemetry.start("other", { mode: "live", name: "bad-parent", details: { kind: "tool", attributes: {} }, parentSpanId: operation.spanId }), /outside/);
    assert.throws(() => store.telemetry.complete("other", intent(operation.operationId)), /unadmitted/);
    if (price.kind !== "priced") throw new Error("Expected fixture price");
    assert.throws(() => store.telemetry.start("run", { mode: "live", name: "forged-price", startedAt: at, details: { ...details, price: { ...price, rate: { ...price.rate, outputMicrousdPerMillion: 0 } } } }), /hash mismatch/);
    const settled = store.telemetry.complete("run", intent(operation.operationId));
    const another = start(store);
    const event = store.createEvent("run", "observation.completed", { ...settled, operationId: another.operationId });
    assert.throws(() => store.appendEventSync({ ...event, id: `observation-complete:${another.operationId}`, timestamp: "2026-11-02T00:00:00.020Z" }), /accounting/);
    assert.equal(store.telemetry.operations("run")[1].completion, null);
  } finally { store.database.sqlite.close(); }
});

test("R7 settlement failure rolls back and retry settles exactly once", () => {
  const store = new SQLiteRuntimeStore();
  try {
    admit(store);
    const operation = start(store);
    store.database.sqlite.exec("create trigger fail_settlement before insert on runtime_events when new.type='observation.completed' begin select raise(abort, 'settlement fault'); end");
    assert.throws(() => store.telemetry.complete("run", intent(operation.operationId)), /settlement fault/);
    assert.equal(store.telemetry.operations("run")[0].completion, null);
    store.database.sqlite.exec("drop trigger fail_settlement");
    store.telemetry.complete("run", intent(operation.operationId));
    store.telemetry.complete("run", intent(operation.operationId));
    assert.deepEqual(store.database.sqlite.prepare("select count(*) as n from runtime_events where type='observation.completed'").get(), { n: 1 });
  } finally { store.database.sqlite.close(); }
});

test("R7 cancellation and memory clear block new dispatch but preserve prior accounting", async () => {
  for (const fence of ["cancel", "clear"] as const) {
    const store = new SQLiteRuntimeStore();
    try {
      admit(store);
      store.memory.capture("run", "telemetry");
      const operation = start(store);
      if (fence === "cancel") store.appendEventSync(store.createEvent("run", "run.cancel_requested", { reason: "operator" }));
      else await store.clearMemory();
      assert.throws(() => start(store), /observations|cleared/);
      const settled = store.telemetry.complete("run", intent(operation.operationId));
      assert.ok(settled.cost.kind === "estimated" && settled.cost.nanoUsd === 113_000);
      assert.throws(() => start(store), /observations|cleared/);
    } finally { store.database.sqlite.close(); }
  }
});

test("R7 interruption is unknown exposure without invented duration or duplicate recovery", () => {
  const store = new SQLiteRuntimeStore();
  try {
    admit(store);
    const operation = start(store);
    const recovered = store.telemetry.interruptOpen("run");
    assert.equal(recovered.length, 1);
    assert.deepEqual(recovered[0].usage, { kind: "unknown", reason: "worker_interrupted" });
    assert.equal(recovered[0].cost.kind, "unknown");
    assert.equal("durationMs" in recovered[0].result, false);
    assert.deepEqual(store.telemetry.interruptOpen("run"), []);
    assert.throws(() => store.telemetry.complete("run", intent(operation.operationId)), /Conflicting/);
  } finally { store.database.sqlite.close(); }
});

test("R7 nonpaid work cannot masquerade as model usage, and stored attributes are redacted", () => {
  const secret = "fixture-private-api-key-value";
  const store = new SQLiteRuntimeStore({ secrets: [secret] });
  try {
    admit(store);
    const operation = store.telemetry.start("run", { mode: "demo", name: "demo", details: { kind: "llm", provider: "fixture", model: "model", turn: 1, billing: "demo", price: { kind: "unknown", reason: "price_missing" }, reservation: { kind: "unknown", reason: "demo" } } });
    assert.throws(() => store.telemetry.complete("run", intent(operation.operationId)), /Nonpaid/);
    const result = store.telemetry.complete("run", { ...intent(operation.operationId), usage: { kind: "not_applicable" } });
    assert.deepEqual(result.cost, { kind: "not_applicable" });
    store.telemetry.start("run", { mode: "demo", name: "source", details: { kind: "source", attributes: { detail: secret } } });
    const rows = store.database.sqlite.prepare("select payload_json from runtime_events").all();
    assert.equal(JSON.stringify(rows).includes(secret), false);
  } finally { store.database.sqlite.close(); }
});
