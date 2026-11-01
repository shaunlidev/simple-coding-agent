import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createAgentOpsServer } from "../packages/server/dist/index.js";
import { createDeepSeekProvider } from "../packages/ai/dist/index.js";
import { SafeNetwork } from "../packages/security/dist/index.js";

let transportStarted = 0; let transportAborted = 0; let calls = 0;
const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ signal }) => {
  transportStarted++;
  return new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => { transportAborted++; reject(signal.reason); }, { once: true });
  });
} });
const probe = createServer(); await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const secret = "synthetic-r5-operator-credential-32-bytes";
const server = await createAgentOpsServer({ startScheduler: true, env: {
  AGENT_DB_PATH: ":memory:", AGENT_DEMO_MODE: "0", AGENT_PUBLIC_ORIGIN: origin, AGENT_CORS_ORIGIN: origin,
  AGENT_SESSION_SECRET: "synthetic-r5-session-signing-secret-32-bytes", AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret }]),
}, network, providerFactory: () => createDeepSeekProvider({ apiKey: "synthetic", fetch: async () => {
  calls++;
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "read", type: "function", function: { name: "collect_source", arguments: '{"sourceId":"source"}' } }] } }] });
} }) });
server.runtime.saveContentTask({ id: "browser-cancel", title: "Browser cancellation", instruction: "Read the configured page", model: "fixture", sources: [{ id: "source", kind: "browser", url: "https://source.test/page" }], limits: { sourceTimeoutMs: 30000 } }, 0);
const output = resolve("artifacts/acceptance/R5"); let browser;
try {
  await mkdir(output, { recursive: true }); await server.app.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin); await page.getByLabel("User ID").fill("owner"); await page.getByLabel("Access secret").fill(secret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await page.getByLabel("Schedule name", { exact: true }).fill("Hourly browser research");
  await page.getByLabel("Cron or interval").fill("@every 1h"); await page.getByLabel("Timezone", { exact: true }).fill("UTC");
  await page.getByLabel("Overlap policy").selectOption("queue");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/schedules") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create schedule", exact: true }).click();
  const response = await created; assert.equal(response.status(), 200); const schedule = await response.json();
  const row = page.locator(".scheduleRow").filter({ hasText: "Hourly browser research" });
  assert.equal(await row.locator("time").first().getAttribute("datetime"), schedule.nextRunAt);
  const runResponse = page.waitForResponse((response) => response.url().includes(`/api/schedules/${schedule.id}/run-now`));
  await row.getByRole("button", { name: "Run schedule", exact: true }).click();
  const runId = (await (await runResponse).json()).runId;
  for (let index = 0; index < 100 && transportStarted === 0; index++) await delay(50);
  assert.equal(transportStarted, 1, "actual Chromium must reach the guarded transport before cancellation");
  await page.getByLabel("Run history", { exact: true }).selectOption(runId);
  const cancelled = page.waitForResponse((response) => response.url().endsWith(`/api/runs/${runId}/cancel`));
  await page.getByRole("button", { name: "Cancel run", exact: true }).click(); assert.equal((await cancelled).status(), 200);
  await server.scheduler.idle();
  const detail = server.runtime.readRunDetail(runId);
  assert.equal(detail.run.status, "cancelled"); assert.equal(detail.result, null); assert.equal(calls, 1); assert.equal(transportAborted, 1);
  assert.equal(server.runtime.readSchedulesSync()[0].nextRunAt, schedule.nextRunAt);
  const pauseResponse = page.waitForResponse((response) => response.url().endsWith(`/api/schedules/${schedule.id}`) && response.request().method() === "PATCH");
  await row.getByRole("button", { name: "Pause", exact: true }).click(); assert.equal((await pauseResponse).status(), 200);
  assert.equal(server.runtime.readSchedulesSync()[0].enabled, false);
  const resumeResponse = page.waitForResponse((response) => response.url().endsWith(`/api/schedules/${schedule.id}`) && response.request().method() === "PATCH");
  await row.getByRole("button", { name: "Resume", exact: true }).click(); const resumed = await (await resumeResponse).json();
  assert.equal(resumed.enabled, true); assert.ok(new Date(resumed.nextRunAt) > new Date());
  assert.equal(resumed.lastTrigger, "manual");
  assert.ok((await row.textContent()).includes("trigger manual"));
  await page.screenshot({ path: resolve(output, "scheduler-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await row.screenshot({ path: resolve(output, "scheduler-mobile.png") });
  assert.deepEqual(errors, []);
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, evidence: "Actual Dashboard/API and Chromium source cancellation; controlled provider/transport, no live model", runId, schedule, resumed, detail, calls, transportStarted, transportAborted, errors, viewports: [1440, 390] };
  assert.equal(JSON.stringify(report).includes(secret), false);
  await writeFile(resolve(output, "ui-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: "passed", runId, calls, transportAborted, report: resolve(output, "ui-report.json") }) + "\n");
} catch (error) {
  await writeFile(resolve(output, `ui-failure-${Date.now()}.json`), JSON.stringify({ message: error.message, jobs: server.scheduler.listJobs(), events: await server.runtime.listEvents(), calls, transportStarted, transportAborted }, null, 2)); throw error;
} finally { await browser?.close(); await server.app.close(); server.database.sqlite.close(); }
