import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { chromium } from "playwright";

const temporary = await mkdtemp(join(tmpdir(), "agent-r3-browser-"));
const databasePath = join(temporary, "state.sqlite");
const output = resolve("artifacts/acceptance/R3");
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const credential = "synthetic-r3-operator-credential-32-bytes";
let child;
let exited;
let browser;
const logs = [];

async function start() {
  child = spawn(process.execPath, ["packages/server/dist/entry.js"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", AGENT_DB_PATH: databasePath, AGENT_SERVER_HOST: "127.0.0.1", AGENT_SERVER_PORT: String(port), AGENT_PUBLIC_ORIGIN: origin, AGENT_CORS_ORIGIN: origin,
      AGENT_SESSION_SECRET: "synthetic-r3-session-signing-secret-32-bytes", AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret: credential }]) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => logs.push(String(data)));
  child.stderr.on("data", (data) => logs.push(String(data)));
  exited = new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error("API process exited before readiness");
    try { if ((await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("API readiness timed out");
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const kill = setTimeout(() => child?.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(kill); child = undefined; }
}

try {
  await mkdir(output, { recursive: true });
  await start();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel("User ID").fill("owner");
  await page.getByLabel("Access secret").fill(credential);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Run history", { exact: true }).waitFor();
  assert.deepEqual((await context.request.get(`${origin}/api/runs`).then((response) => response.json())).runs, []);
  const runIds = [];
  for (let index = 0; index < 3; index++) {
    const response = page.waitForResponse((response) => response.url() === `${origin}/api/runs/run-now` && response.request().method() === "POST");
    await page.getByRole("button", { name: "Run now", exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200);
    runIds.push((await result.json()).runId);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Run now" && !button.disabled));
  }
  assert.equal(new Set(runIds).size, 3);
  const details = await Promise.all(runIds.map((id) => context.request.get(`${origin}/api/runs/${id}`).then((response) => response.json())));
  const deliveredCount = details[0].result.deliveredCount;
  assert.ok(deliveredCount > 0);
  assert.deepEqual(details.map((detail) => detail.result.outcome), ["delivered", "no_new_items", "no_new_items"]);
  assert.deepEqual(details.map((detail) => detail.result.deliveredCount), [deliveredCount, 0, 0]);
  for (const detail of details) assert.equal(detail.result.items.length, details[0].result.items.length);
  const history = page.locator('[aria-label="Historical run result"]');
  await page.getByLabel("Run history", { exact: true }).selectOption(runIds[2]);
  await history.getByText("No new items", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "no-new-items-desktop.png"), fullPage: true });
  await page.getByLabel("Run history", { exact: true }).selectOption(runIds[0]);
  await history.getByText(runIds[0], { exact: true }).waitFor();
  assert.equal(await history.getByText("No new items", { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator(".runHistory").screenshot({ path: join(output, "history-mobile.png") });
  await page.goto("about:blank");
  await stop();
  await start();
  await page.goto(origin);
  await page.getByLabel("Run history", { exact: true }).waitFor();
  await page.getByLabel("Run history", { exact: true }).selectOption(runIds[0]);
  await page.locator('[aria-label="Historical run result"]').getByText(runIds[0], { exact: true }).waitFor();
  const restored = await context.request.get(`${origin}/api/runs/${runIds[0]}`).then((response) => response.json());
  assert.deepEqual(restored, details[0]);
  assert.equal((await context.request.get(`${origin}/api/runs`).then((response) => response.json())).runs.length, 3);
  assert.deepEqual(errors, []);
  await browser.close();
  browser = undefined;
  await stop();
  const database = new Database(databasePath, { readonly: true });
  const counts = {
    runs: database.prepare("select count(*) as count from run_requests").get().count,
    results: database.prepare("select count(*) as count from run_content_results").get().count,
    deliveries: database.prepare("select count(*) as count from content_deliveries").get().count,
    deliveryEvents: database.prepare("select count(*) as count from runtime_events where type = 'delivery.created'").get().count,
    skippedDeliveries: database.prepare("select count(*) as count from runtime_events where type = 'delivery.skipped'").get().count,
  };
  database.close();
  assert.deepEqual(counts, { runs: 3, results: details[0].result.items.length * 3, deliveries: deliveredCount, deliveryEvents: 1, skippedDeliveries: 2 });
  assert.equal(logs.join("").includes(credential), false);
  const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) };
  const report = { checkedAt: new Date().toISOString(), source, counts, runIds, outcomes: details.map((detail) => detail.result.outcome), actualProcessRestart: true, sessionSurvivedRestart: true, historicalResultUnchanged: true, viewports: [1440, 390], errors, provider: "Explicitly demo runtime; no provider credentials or real model calls" };
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await stop();
  await rm(temporary, { recursive: true, force: true });
}
