import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDeepSeekProvider } from "../packages/ai/dist/index.js";
import { SQLiteRuntimeStore, executeContentRun, contentTaskSchema } from "../packages/runtime/dist/index.js";
import { SafeNetwork } from "../packages/security/dist/index.js";

if (process.env.RUN_DEEPSEEK_LIVE !== "1" || !process.env.DEEPSEEK_API_KEY) {
  process.stderr.write("SKIPPED: requires RUN_DEEPSEEK_LIVE=1 and DEEPSEEK_API_KEY; no live evidence produced.\n"); process.exit(2);
}
const output = resolve("artifacts/acceptance/R7");
const store = new SQLiteRuntimeStore({ secrets: [process.env.DEEPSEEK_API_KEY], network: new SafeNetwork({ allowlist: ["https://usage.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => ({ url: url.href, status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("<html><title>SQLite transaction evidence</title><body><article>SQLite transactions commit changes atomically. The application records a delivery receipt in the same transaction.</article></body></html>") }) }) });
const task = contentTaskSchema.parse({ id: "live-usage-check", title: "Live usage acceptance", instruction: "Read the configured source. Return exactly one result about its SQLite transaction behavior, with one short verbatim quote from the tool result.", model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
  sources: [{ id: "sqlite", kind: "url", url: "https://usage.test/article" }],
  limits: { maxTurns: 3, maxToolCalls: 2, maxOutputTokens: 1024, maxDocumentsPerSource: 1, maxTextChars: 1200, maxDeliveries: 1, sourceTimeoutMs: 5000, runTimeoutMs: 120000 },
});
store.saveContentTask(task, 0);
const { runId } = store.admitContentRun({ actor: "live-harness", key: "bounded-wire-usage", taskId: task.id, trigger: "manual" });
const captures = [];
function wireUsage(text, status, began) {
  const blocks = text.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")).filter((data) => data && data !== "[DONE]").map((data) => JSON.parse(data));
  const last = blocks.findLast((block) => block.usage);
  const usage = last?.usage;
  return { status, model: last?.model ?? blocks.find((block) => block.model)?.model ?? null, durationMs: performance.now() - began,
    usage: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens,
      cacheHit: usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? null, cacheMiss: usage.prompt_cache_miss_tokens ?? null } : null };
}
let failure; let wire = [];
try {
  await executeContentRun(store, runId, { providerFactory: () => createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, model: task.model, stream: true, maxOutputTokens: task.limits.maxOutputTokens, responseFormat: "json_object", toolChoice: "required", fetch: async (url, init) => {
    const began = performance.now(); const response = await fetch(url, init);
    captures.push(response.clone().text().then((body) => wireUsage(body, response.status, began)).catch((error) => ({ error: store.redactor.text(String(error)) })));
    return response;
  } }) });
  wire = await Promise.all(captures);
  const detail = store.readRunDetail(runId); const operations = store.telemetry.operations(runId);
  const calls = operations.filter((operation) => operation.start.details.kind === "llm");
  assert.equal(detail.run.status, "completed"); assert.equal(detail.result.items.length, 1);
  assert.ok(wire.length >= 2 && wire.length <= 3); assert.equal(calls.length, wire.length);
  for (const [index, call] of calls.entries()) {
    const captured = wire[index]; assert.equal(captured.status, 200); assert.ok(captured.usage);
    assert.equal(call.completion.usage.kind, "reported");
    const usage = call.completion.usage.value;
    assert.deepEqual([usage.input, usage.output, usage.totalTokens], [captured.usage.input, captured.usage.output, captured.usage.total]);
    if (captured.usage.cacheHit !== null) assert.equal(usage.cacheReadInput, captured.usage.cacheHit);
    if (captured.usage.cacheMiss !== null) assert.equal(usage.cacheMissInput, captured.usage.cacheMiss);
    assert.equal(call.completion.responseModel, captured.model);
    assert.equal(call.completion.result.state, "finished"); assert.equal(call.completion.result.outcome, "ok"); assert.ok(call.completion.result.durationMs > 0);
    assert.equal(call.completion.cost.kind, "unknown");
  }
  assert.equal(detail.run.inputTokens, wire.reduce((sum, call) => sum + call.usage.input, 0));
  assert.equal(detail.run.outputTokens, wire.reduce((sum, call) => sum + call.usage.output, 0));
  assert.equal(detail.run.costUsd, null);
  for (const kind of ["tool", "source", "security", "delivery"]) assert.ok(operations.some((operation) => operation.start.details.kind === kind && operation.completion?.result.outcome === "ok"));
  assert.equal(store.readTrace(runId).omittedFromOtlp.length, 0);
} catch (error) { failure = store.redactor.text(error instanceof Error ? error.message : String(error)); wire = await Promise.all(captures); }
try {
  await mkdir(output, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, status: failure ? "failed" : "passed", failure,
    evidence: "Real DeepSeek streaming responses and tool calls, controlled HTML source. Independently extracted wire usage compared with persisted settlement. At most 3 turns, 2 tools, 1024 output tokens per turn. No rate catalog: cost unknown, not invoice validation.", runId, wire, operations: store.telemetry.operations(runId), run: store.readRunDetail(runId)?.run };
  const path = resolve(output, `live-observability-${runId}.json`);
  await writeFile(path, store.redactor.json(report));
  process.stdout.write(JSON.stringify({ status: report.status, runId, failure, wire, report: path }) + "\n");
  if (failure) process.exitCode = 1;
} finally { store.database.sqlite.close(); }
