import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createAgentOpsServer } from "../packages/server/dist/index.js";
import { createDeepSeekProvider } from "../packages/ai/dist/index.js";
import { SafeNetwork } from "../packages/security/dist/index.js";

const output = resolve("artifacts/acceptance/R4");
const nonce = `Fresh release ${randomUUID()}`;
const secret = "synthetic-r4-operator-credential-32-bytes";
const requests = [];
const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => ({
  url: url.href, status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode(`<html><title>Fresh source</title><body><article>${nonce}. Actual browser-collected release evidence.</article></body></html>`),
}) });
const providerFactory = (task) => createDeepSeekProvider({ apiKey: "synthetic-provider-key", stream: false, model: task.model, maxOutputTokens: task.limits.maxOutputTokens, fetch: async (_url, options) => {
  const request = JSON.parse(options.body);
  requests.push(request);
  const result = request.messages.find((message) => message.role === "tool");
  if (!result) return Response.json({
    model: "controlled-deepseek-contract",
    choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "collect-1", type: "function", function: { name: "collect_source", arguments: '{"sourceId":"source-1"}' } }] } }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
  const outcome = JSON.parse(result.content);
  const observed = outcome.status === "ok" ? outcome.documents[0] : undefined;
  if (!observed) return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"items":[]}' } }] });
  return Response.json({ model: "controlled-deepseek-contract", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ documentId: observed.id, summary: observed.text, reason: "Fresh release evidence from the requested source.", score: 90, quotes: [nonce] }] }) } }], usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 } });
} });
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const server = await createAgentOpsServer({ env: {
  NODE_ENV: "test", AGENT_DB_PATH: ":memory:", AGENT_DEMO_MODE: "0", AGENT_SESSION_SECRET: "synthetic-r4-session-signing-secret-32-bytes",
  AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret }]),
  AGENT_PUBLIC_ORIGIN: origin, AGENT_CORS_ORIGIN: origin,
}, network, providerFactory });
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.app.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel("User ID").fill("owner");
  await page.getByLabel("Access secret").fill(secret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Task name", { exact: true }).fill("Browser release research");
  await page.getByLabel("Research request").fill("Summarize the fresh release with exact evidence.");
  await page.getByLabel("Source type").selectOption("browser");
  await page.getByLabel("Source URL").fill("https://source.test/news");
  const saved = page.waitForResponse((response) => response.url().includes("/api/tasks/") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  assert.equal((await saved).status(), 200);
  const runResponse = page.waitForResponse((response) => response.url().endsWith("/api/runs/run-now") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  const runId = (await (await runResponse).json()).runId;
  let detail;
  for (let attempt = 0; attempt < 150; attempt++) {
    detail = await context.request.get(`${origin}/api/runs/${runId}`).then((response) => response.json());
    if (["completed", "failed", "cancelled"].includes(detail.run.status)) break;
    await delay(100);
  }
  if (detail.run.status !== "completed") await writeFile(resolve(output, `controlled-failed-${runId}.json`), JSON.stringify(detail, null, 2));
  assert.equal(detail.run.status, "completed", JSON.stringify({ failures: detail.sources, events: detail.events.filter((event) => event.type === "run.failed") }));
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.content.includes(nonce)));
  assert.ok(detail.result.items[0].summary.includes(nonce));
  assert.equal(detail.result.items[0].citations[0].quote, nonce);
  assert.equal(detail.sources[0].documents[0].representation, "page_text");
  await page.getByLabel("Run history", { exact: true }).selectOption(runId);
  assert.equal(await page.locator(".runHistory").getByRole("link", { name: "Fresh source", exact: true }).getAttribute("href"), "https://source.test/news");
  await page.getByText("Tool result: collect_source", { exact: true }).click();
  await page.screenshot({ path: resolve(output, "controlled-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator(".runHistory").screenshot({ path: resolve(output, "controlled-mobile.png") });
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, evidence: "Controlled provider/transport; actual API, database, Dashboard and isolated Chromium source collection. Not public-source or live-model evidence.", runId, requests, detail, errors, viewports: [1440, 390] };
  assert.equal(JSON.stringify(report).includes(secret), false);
  await writeFile(resolve(output, "controlled-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ runId, status: detail.run.status, calls: requests.length, report: resolve(output, "controlled-report.json") }) + "\n");
} finally {
  await browser?.close();
  await server.app.close();
  server.database.sqlite.close();
}
