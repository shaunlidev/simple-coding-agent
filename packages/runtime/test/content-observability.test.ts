import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeekProvider } from "@simple-coding-agent/ai";
import { SafeNetwork } from "@simple-coding-agent/security";
import { SQLiteRuntimeStore, RuntimeScheduler } from "../src/index.ts";
import { executeContentRun } from "../src/content-agent.ts";
import { ContentDispatch } from "../src/content-dispatch.ts";
import { contentTaskSchema, sourceReadSchema, type ContentTask } from "../src/content-contract.ts";
import { freezePrice, type PriceRate } from "../src/pricing.ts";

const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 };
function fixture(options: { limits?: Partial<ContentTask["limits"]>; usage?: typeof usage | null; secondUsage?: typeof usage; prices?: PriceRate[]; failedSource?: boolean; blockedProvider?: boolean } = {}) {
  let sends = 0; let reads = 0; let aborted = false;
  const caps: number[] = [];
  const rate: PriceRate = { version: "fixture-v1", provider: "deepseek", model: "model", source: "https://example.test/rates", checkedAt: new Date().toISOString(), validFrom: new Date(Date.now() - 86400000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), inputMicrousdPerMillion: 1_000_000, cachedInputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 2_000_000 };
  const prices = options.prices ?? [rate];
  const store = new SQLiteRuntimeStore({ network: new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => {
    reads++;
    return { url: url.href, status: options.failedSource ? 503 : 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("Observed evidence of SQLite durable transactions.") };
  } }) });
  const task = contentTaskSchema.parse({ id: "task", title: "Observation test", instruction: "Collect release evidence", model: "model", sources: [{ id: "source", kind: "url", url: "https://source.test/page" }], limits: { maxOutputTokens: 128, ...options.limits } });
  store.saveContentTask(task, 0);
  const { runId } = store.admitContentRun({ actor: "operator", key: "request", taskId: task.id, trigger: "manual" });
  const provider = createDeepSeekProvider({ apiKey: "fixture", model: "model", fetch: async (_url, init) => {
    sends++;
    if (options.blockedProvider) return new Promise<Response>((_resolve, reject) => {
      const abort = () => { aborted = true; reject(new Error("Transport aborted")); };
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
    });
    const request = JSON.parse(String(init?.body));
    caps.push(request.max_tokens);
    const tool = request.messages.find((message: { role: string }) => message.role === "tool");
    const result = tool ? sourceReadSchema.parse(JSON.parse(tool.content)) : undefined;
    const document = result?.status === "ok" ? result.documents[0] : undefined;
    const choice = !tool ? { finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "collect_source", arguments: '{"sourceId":"source"}' } }] } }
      : { finish_reason: "stop", message: { content: JSON.stringify({ items: document ? [{ documentId: document.id, summary: "SQLite transactions provide durable storage.", reason: "Matches the requested release evidence.", score: 80, quotes: [document.text] }] : [] }) } };
    return Response.json({ model: "model", choices: [choice], ...(options.usage === null ? {} : { usage: sends === 2 && options.secondUsage ? options.secondUsage : options.usage ?? usage }) });
  } });
  return { store, task, runId, prices, sends: () => sends, reads: () => reads, aborted: () => aborted, caps, run: () => executeContentRun(store, runId, { providerFactory: () => provider, prices }) };
}

test("R7 actual dispatch records model/tool/source boundaries, parents, reported usage and output cap", async () => {
  const f = fixture();
  try {
    await f.run();
    assert.equal(f.sends(), 2);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.caps, [128, 128]);
    const operations = f.store.telemetry.operations(f.runId);
    assert.deepEqual(operations.map(({ start }) => start.details.kind), ["memory", "memory", "llm", "tool", "security", "source", "llm", "eval", "delivery"]);
    assert.ok(operations.every(({ completion }) => completion?.result.state === "finished" && completion.result.outcome === "ok" && completion.result.durationMs >= 0));
    assert.equal(operations[4].start.parentSpanId, operations[3].start.spanId);
    assert.equal(operations[5].start.parentSpanId, operations[3].start.spanId);
    assert.equal(new Set(operations.map(({ start }) => start.traceId)).size, 1);
    const calls = operations.filter(({ start }) => start.details.kind === "llm");
    assert.deepEqual(calls.map(({ completion }) => completion?.cost.kind === "estimated" ? completion.cost.nanoUsd : null), [113_000, 113_000]);
    assert.equal(f.store.readRunResult(f.runId)?.outcome, "delivered");
  } finally { f.store.database.sqlite.close(); }
});

for (const [label, limits, prices, code] of [
  ["low cost", { maxCostUsd: 0.000000001 }, undefined, "cost_budget_preflight"],
  ["missing price", { maxCostUsd: 1 }, [], "price_unknown"],
  ["low tokens", { maxTotalTokens: 1 }, undefined, "token_budget_preflight"],
] as const) {
  test(`R7 ${label} denies before actual provider transport`, async () => {
    const f = fixture({ limits, prices: prices ? [...prices] : undefined });
    try {
      await assert.rejects(f.run(), new RegExp(code));
      assert.equal(f.sends(), 0); assert.equal(f.reads(), 0);
      assert.equal(f.store.telemetry.operations(f.runId).some(({ start }) => start.details.kind === "llm"), false);
      assert.ok((await f.store.listEvents(f.runId)).some((event) => event.type === "observation.denied" && event.payload.reason === code));
    } finally { f.store.database.sqlite.close(); }
  });
}

for (const [limits, expected] of [[{ maxTotalTokens: 10_000 }, "token_budget_exceeded"], [{ maxCostUsd: 0.05 }, "cost_budget_exceeded"]] as const) {
  test(`R7 ${expected} settles incurred usage then blocks tools and later model dispatch`, async () => {
    const f = fixture({ limits, usage: { ...usage, prompt_tokens: 2_000_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2_000_000, total_tokens: 2_000_020 } });
    try {
      await assert.rejects(f.run(), new RegExp(expected));
      assert.equal(f.sends(), 1); assert.equal(f.reads(), 0);
      const call = f.store.telemetry.operations(f.runId).find(({ start }) => start.details.kind === "llm");
      assert.ok(call?.completion?.usage.kind === "reported" && call.completion.usage.value.totalTokens === 2_000_020);
      assert.equal(f.store.readRunResult(f.runId), undefined);
    } finally { f.store.database.sqlite.close(); }
  });
}

test("R7 missing usage fails closed only when accounting is required, otherwise stays unknown", async () => {
  for (const required of [true, false]) {
    const f = fixture({ usage: null, limits: required ? { maxCostUsd: 0.05 } : {} });
    try {
      if (required) { await assert.rejects(f.run(), /usage_unknown/); assert.equal(f.sends(), 1); assert.equal(f.reads(), 0); }
      else { await f.run(); assert.equal(f.sends(), 2); }
      const calls = f.store.telemetry.operations(f.runId).filter(({ start }) => start.details.kind === "llm");
      assert.ok(calls.every(({ completion }) => completion?.usage.kind === "unknown" && completion.cost.kind === "unknown"));
    } finally { f.store.database.sqlite.close(); }
  }
});

test("R7 deadline abort reaches provider transport and leaves unknown cost, not zero", { timeout: 5000 }, async () => {
  const f = fixture({ blockedProvider: true, limits: { runTimeoutMs: 100 } });
  try {
    await assert.rejects(f.run());
    assert.equal(f.sends(), 1); assert.equal(f.reads(), 0); assert.equal(f.aborted(), true);
    const call = f.store.telemetry.operations(f.runId).find(({ start }) => start.details.kind === "llm");
    assert.ok(call?.completion?.result.state === "finished" && call.completion.result.outcome === "cancelled");
    assert.equal(call.completion.cost.kind, "unknown");
    assert.equal((await f.store.listEvents(f.runId)).find((event) => event.type === "run.failed")?.payload.reason, "run_timeout");
  } finally { f.store.database.sqlite.close(); }
});

test("R7 failing source and its tool are error observations even when tool protocol succeeds", async () => {
  const f = fixture({ failedSource: true });
  try {
    await assert.rejects(f.run(), /All configured sources failed/);
    const operations = f.store.telemetry.operations(f.runId).filter(({ start }) => ["tool", "source"].includes(start.details.kind));
    assert.equal(operations.length, 2);
    assert.ok(operations.every(({ completion }) => completion?.result.state === "finished" && completion.result.outcome === "error"));
  } finally { f.store.database.sqlite.close(); }
});

test("R7 failure persisting settlement blocks advancement and keeps the original exposure", async () => {
  const f = fixture();
  try {
    f.store.database.sqlite.exec("create trigger fail_model_settlement before insert on runtime_events when new.type='observation.completed' and json_extract(new.payload_json, '$.usage.kind')='reported' begin select raise(abort, 'model settlement fault'); end");
    await assert.rejects(f.run(), /model settlement fault/);
    assert.equal(f.sends(), 1); assert.equal(f.reads(), 0);
    assert.equal(f.store.telemetry.operations(f.runId).find(({ start }) => start.details.kind === "llm")?.completion, null);
  } finally { f.store.database.sqlite.close(); }
});

test("R7 cancellation after response preserves usage but forbids advancement", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    f.store.appendEventSync(f.store.createEvent(f.runId, "run.started", { title: f.task.title, trigger: "manual" }));
    const dispatch = new ContentDispatch(f.store, f.runId, f.task, controller.signal, f.prices);
    await assert.rejects(dispatch.model({ turn: 1, model: { provider: "deepseek", id: "model", name: "Model" }, context: { messages: [] } }, async () => {
      controller.abort(new Error("operator cancelled"));
      return { role: "assistant", model: "model", content: [], stopReason: "stop", usage: { input: 100, output: 20, totalTokens: 120, cacheReadInput: 30 } };
    }), /operator cancelled/);
    const call = f.store.telemetry.operations(f.runId).find(({ start }) => start.details.kind === "llm");
    assert.ok(call);
    assert.ok(call.completion?.cost.kind === "estimated" && call.completion.cost.nanoUsd === 113_000);
    assert.ok(call.completion.result.state === "finished" && call.completion.result.outcome === "cancelled");
  } finally { f.store.database.sqlite.close(); }
});

test("R7 worker ownership recovery settles open paid calls without retrying them", async () => {
  const f = fixture();
  let executions = 0;
  const worker = new RuntimeScheduler({ runtime: f.store, runAgent: async ({ runId }) => { executions++; return runId; } });
  try {
    f.store.appendEventSync(f.store.createEvent(f.runId, "run.started", { title: f.task.title, trigger: "manual" }));
    f.store.telemetry.start(f.runId, { mode: "live", name: "interrupted model", details: { kind: "llm", provider: "deepseek", model: "model", turn: 1, billing: "paid", price: freezePrice(f.prices, { provider: "deepseek", model: "model", at: new Date().toISOString() }), reservation: { kind: "unknown", reason: "fixture" } } });
    await worker.tick();
    assert.equal(executions, 0);
    assert.equal((await f.store.projectRun(f.runId)).status, "failed");
    const call = f.store.telemetry.operations(f.runId).find(({ start }) => start.details.kind === "llm");
    assert.ok(call);
    assert.equal(call.completion?.result.state, "interrupted");
    assert.equal(call.completion?.cost.kind, "unknown");
    await worker.tick();
    assert.equal(executions, 0);
    assert.equal(f.store.telemetry.operations(f.runId).filter(({ start }) => start.details.kind === "llm").length, 1);
  } finally { await worker.stop(); f.store.database.sqlite.close(); }
});

test("R7 explicit budget degradation uses only collected evidence without another paid call", async () => {
  const f = fixture({ limits: { maxTotalTokens: 10_000, onBudgetOverflow: "extractive" }, secondUsage: { ...usage, prompt_tokens: 20_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20_000, total_tokens: 20_020 } });
  try {
    await f.run();
    assert.equal(f.sends(), 2); assert.equal(f.reads(), 1);
    const result = f.store.readRunResult(f.runId);
    assert.equal(result?.outcome, "delivered");
    assert.match(result.items[0].summary, /^Source excerpt:/);
    assert.match(result.items[0].reason, /token_budget_exceeded/);
    const completion = (await f.store.listEvents(f.runId)).find((event) => event.type === "run.completed");
    assert.equal(completion?.payload.quality, "degraded");
    assert.equal(completion.payload.budgetReason, "token_budget_exceeded");
    assert.equal(f.store.telemetry.operations(f.runId).filter(({ start }) => start.details.kind === "llm").length, 2);
  } finally { f.store.database.sqlite.close(); }
});

test("R7 extractive mode cannot bypass missing usage or invent uncollected source evidence", async () => {
  for (const options of [{ limits: { maxCostUsd: 0.05, onBudgetOverflow: "extractive" as const }, usage: null }, { limits: { maxTotalTokens: 1, onBudgetOverflow: "extractive" as const } }]) {
    const f = fixture(options);
    try {
      await assert.rejects(f.run(), /usage_unknown|every configured source/);
      assert.equal(f.reads(), 0);
      assert.equal(f.store.readRunResult(f.runId), undefined);
    } finally { f.store.database.sqlite.close(); }
  }
});
