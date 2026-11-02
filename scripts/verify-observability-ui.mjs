import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createAgentOpsServer } from "../packages/server/dist/index.js";
import { createDeepSeekProvider } from "../packages/ai/dist/index.js";
import { SafeNetwork } from "../packages/security/dist/index.js";

const output = resolve("artifacts/acceptance/R7");
const secret = "synthetic-r7-operator-credential-32-bytes";
const model = "r7-fixture";
const price = { version: "controlled-v1", provider: "deepseek", model, source: "https://example.test/fixture", checkedAt: new Date().toISOString(), validFrom: "2000-01-01T00:00:00.000Z", validUntil: "2100-01-01T00:00:00.000Z", inputMicrousdPerMillion: 1_000_000, cachedInputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 2_000_000 };
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 };
let calls = 0; let sourceReads = 0; let phase = "setup";
const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => {
  sourceReads++;
  return { url: url.href, status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode("<html><title>Observed release</title><body><article>Controlled SQLite release evidence with durable transactions.</article></body></html>") };
} });
const providerFactory = (task) => createDeepSeekProvider({ apiKey: "synthetic-provider", model: task.model, fetch: async (_url, init) => {
  calls++;
  const request = JSON.parse(init.body);
  const tool = request.messages.find((message) => message.role === "tool");
  const document = tool ? JSON.parse(tool.content).documents[0] : undefined;
  const choice = !tool ? { finish_reason: "tool_calls", message: { tool_calls: [{ id: "collect", type: "function", function: { name: "collect_source", arguments: '{"sourceId":"source-1"}' } }] } }
    : { finish_reason: "stop", message: { content: JSON.stringify({ items: [{ documentId: document.id, summary: "SQLite provides durable transaction storage.", reason: "Relevant to release research.", score: 85, quotes: [document.text] }] }) } };
  return Response.json({ model: task.model, choices: [choice], ...(task.title === "Unknown usage" && tool ? {} : { usage }) });
} });
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const server = await createAgentOpsServer({ env: { NODE_ENV: "test", AGENT_DB_PATH: ":memory:", AGENT_DEMO_MODE: "0", DEEPSEEK_MODEL: model, AGENT_PRICE_CATALOG: JSON.stringify([price]), AGENT_SESSION_SECRET: "synthetic-r7-session-signing-secret-32-bytes", AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret }]), AGENT_PUBLIC_ORIGIN: origin, AGENT_CORS_ORIGIN: origin }, network, providerFactory });
let browser;
const errors = [];
const lineage = () => ({ commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) });
try {
  await mkdir(output, { recursive: true });
  await server.app.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel("User ID").fill("owner"); await page.getByLabel("Access secret").fill(secret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  phase = "empty state";
  await page.locator(".metricTile").filter({ hasText: "Success rate" }).getByText("No samples", { exact: true }).waitFor();
  assert.match(await page.locator(".metricTile").filter({ hasText: "Secret scan" }).innerText(), /not run/);
  assert.match(await page.locator(".metricTile").filter({ hasText: "Sandbox" }).innerText(), /not configured/);
  async function run(title, cost = "") {
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Task name", { exact: true }).fill(title);
    await page.getByLabel("Research request").fill("Collect source evidence for SQLite releases.");
    await page.getByLabel("Source type").selectOption("browser");
    await page.getByLabel("Source URL").fill("https://source.test/release");
    await page.getByLabel("Estimated budget (USD)", { exact: true }).fill(cost);
    const saved = page.waitForResponse((response) => response.url().includes("/api/tasks/") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    assert.equal((await saved).status(), 200);
    const response = page.waitForResponse((response) => response.url().endsWith("/api/runs/run-now") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Run now", exact: true }).click();
    const runId = (await (await response).json()).runId;
    for (let attempt = 0; attempt < 150; attempt++) {
      const detail = await context.request.get(`${origin}/api/runs/${runId}`).then((response) => response.json());
      if (["completed", "failed", "cancelled"].includes(detail.run.status)) { await server.scheduler.idle(); await page.reload(); await page.getByLabel("Run history", { exact: true }).selectOption(runId); return detail; }
      await delay(100);
    }
    throw new Error("Run did not terminate");
  }
  phase = "measured run";
  const measured = await run("Measured run");
  assert.equal(measured.run.status, "completed"); assert.equal(calls, 2);
  assert.equal(measured.run.costUsd, 0.000226);
  assert.equal(measured.run.inputTokens, 200); assert.equal(measured.run.outputTokens, 40);
  await page.getByText("Run trace", { exact: true }).click();
  await page.locator(".runHistory").getByText("chat r7-fixture", { exact: true }).first().waitFor();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export trace", exact: true }).click();
  const exported = JSON.parse(await readFile(await (await downloaded).path(), "utf8"));
  assert.equal(exported.runId, measured.run.id);
  assert.equal(exported.spans.filter((span) => span.type === "llm").length, 2);
  assert.equal(exported.spans.filter((span) => span.type === "browser").length, 1);
  assert.deepEqual(exported.omittedFromOtlp, []);
  assert.equal(JSON.stringify(exported).includes("Controlled SQLite release evidence"), false);
  await page.screenshot({ path: resolve(output, "observability-desktop.png"), fullPage: true });
  phase = "partial accounting";
  const partial = await run("Unknown usage");
  assert.equal(partial.run.status, "completed"); assert.equal(calls, 4);
  assert.equal(partial.run.costUsd, null); assert.equal(partial.run.accounting.costStatus, "partial");
  assert.equal(partial.run.accounting.knownCostUsd, 0.000113);
  await page.locator(".runHistory").getByText(/1 calls with unknown cost/).waitFor();
  phase = "budget denial";
  const readsBefore = sourceReads;
  const denied = await run("Budget denial", "0.000000001");
  assert.equal(denied.run.status, "failed"); assert.equal(calls, 4); assert.equal(sourceReads, readsBefore);
  assert.ok(denied.events.some((event) => event.type === "observation.denied" && event.payload.reason === "cost_budget_preflight"));
  assert.equal(denied.result, null);
  await page.getByLabel("Run history", { exact: true }).selectOption(partial.run.id);
  await page.getByText("Run trace", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".runHistory").getByText("chat r7-fixture", { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator(".runHistory").evaluate((root) => [...root.querySelectorAll(":scope > div, :scope > div > p, .tableWrap")].every((element) => element.getBoundingClientRect().right <= root.getBoundingClientRect().right + 1)), true);
  await page.locator(".runHistory").screenshot({ path: resolve(output, "observability-mobile.png") });
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), source: lineage(), evidenceKind: "controlled-provider-and-source; actual API, SQLite, Dashboard, Chromium", calls, sourceReads, runs: [measured.run, partial.run, denied.run], trace: exported, errors, viewports: [1440, 390] };
  assert.equal(JSON.stringify(report).includes(secret), false);
  await writeFile(resolve(output, "observability-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: "passed", calls, runs: report.runs.map((run) => run.id), report: resolve(output, "observability-report.json") }) + "\n");
} catch (error) {
  await writeFile(resolve(output, `observability-failed-${Date.now()}.json`), JSON.stringify({ phase, source: lineage(), message: String(error), calls, sourceReads, errors }, null, 2));
  throw error;
} finally { await browser?.close(); await server.app.close(); server.database.sqlite.close(); }
