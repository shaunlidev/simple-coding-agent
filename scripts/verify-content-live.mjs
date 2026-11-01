import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDeepSeekProvider } from "../packages/ai/dist/index.js";
import { SQLiteRuntimeStore, executeContentRun, contentTaskSchema } from "../packages/runtime/dist/index.js";
import { SafeNetwork, createCloudflareResolver } from "../packages/security/dist/index.js";

if (process.env.RUN_DEEPSEEK_LIVE !== "1" || !process.env.DEEPSEEK_API_KEY) {
  process.stderr.write("SKIPPED: requires RUN_DEEPSEEK_LIVE=1 and DEEPSEEK_API_KEY; no live evidence produced.\n");
  process.exit(2);
}
const output = resolve("artifacts/acceptance/R4");
const dnsMode = process.env.AGENT_DNS_MODE ?? "system";
const store = new SQLiteRuntimeStore({ secrets: [process.env.DEEPSEEK_API_KEY], network: new SafeNetwork({ allowlist: ["https://example.com", "https://blog.rust-lang.org"], timeoutMs: 15000, ...(dnsMode === "cloudflare" ? { resolve: createCloudflareResolver() } : {}) }) });
const task = contentTaskSchema.parse({ id: "live-public-content", title: "Public content live acceptance", instruction: "Summarize the Rust release news and the example domain page. Include exactly one item from each successful source with short verbatim quotes from tool results.",
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro", sources: [{ id: "rust-news", kind: "rss", url: "https://blog.rust-lang.org/feed.xml" }, { id: "example-browser", kind: "browser", url: "https://example.com" }],
  limits: { maxTurns: 3, maxToolCalls: 4, maxOutputTokens: 2048, maxDocumentsPerSource: 1, maxTextChars: 1800, maxDeliveries: 2, sourceTimeoutMs: 15000, runTimeoutMs: 120000 },
});
store.saveContentTask(task, 0);
const { runId } = store.admitContentRun({ actor: "live-harness", key: "bounded-live-check", taskId: task.id, trigger: "manual" });
let failure;
try {
  await executeContentRun(store, runId, { providerFactory: (task) => createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY, model: task.model, stream: true, maxOutputTokens: task.limits.maxOutputTokens, responseFormat: "json_object", toolChoice: "required" }) });
  const detail = store.readRunDetail(runId);
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.sources.filter((source) => source.status === "ok").length, 2);
  assert.equal(detail.result.items.length, 2);
  assert.deepEqual(new Set(detail.result.items.map((item) => item.source)), new Set(task.sources.map((source) => source.id)));
  const measured = detail.events.filter((event) => event.type === "agent.model.completed");
  assert.ok(measured.length >= 2 && measured.every((event) => event.payload.usage?.totalTokens > 0));
} catch (error) { failure = store.redactor.text(error instanceof Error ? error.message : String(error)); }
try {
  await mkdir(output, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, status: failure ? "failed" : "passed", failure, evidence: "Real DeepSeek, public RSS and actual Chromium public-page collection; bounded to three provider turns, four tool calls and 2048 generated tokens per request.", detail: store.readRunDetail(runId) };
  await writeFile(resolve(output, `live-${runId}.json`), store.redactor.json({ ...report, dnsMode }));
  process.stdout.write(JSON.stringify({ status: report.status, runId, failure, usage: report.detail.events.filter((event) => event.type === "agent.model.completed").map((event) => event.payload.usage), report: resolve(output, `live-${runId}.json`) }) + "\n");
  if (failure) process.exitCode = 1;
} finally { store.database.sqlite.close(); }
