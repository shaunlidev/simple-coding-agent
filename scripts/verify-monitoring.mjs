import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const directory = await mkdtemp(join(tmpdir(), "agent-r7-monitoring-"));
const output = resolve("artifacts/acceptance/R7"); const children = []; const errors = [];
const secret = "synthetic-monitoring-operator-secret-32-bytes";
let browser; let phase = "startup";
async function freePort() {
  const probe = createServer(); await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port; await new Promise((done) => probe.close(done)); return port;
}
async function launch() {
  const port = await freePort();
  const child = fork(resolve("scripts/fixtures/monitoring-worker.mjs"), [join(directory, "runtime.sqlite"), String(port)], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, DEEPSEEK_API_KEY: "" } });
  const messages = []; let logs = ""; let sequence = 0;
  child.on("message", (message) => messages.push(message));
  child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  const wait = async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) { const found = messages.find(predicate); if (found) return found; await delay(50); }
    throw new Error(`Worker response timeout: ${logs}`);
  };
  const command = async (command) => { const id = ++sequence; child.send({ id, command }); const reply = await wait((message) => message.id === id); if (reply.error) throw new Error(reply.error); return reply.result; };
  const worker = { child, origin: `http://127.0.0.1:${port}`, wait, command, exited, logs: () => logs }; children.push(worker); return worker;
}
async function poll(read, matches) {
  for (let attempt = 0; attempt < 150; attempt++) { const result = await read(); if (matches(result)) return result; await delay(100); }
  throw new Error(`Timed out in ${phase}`);
}
try {
  await mkdir(output, { recursive: true });
  const first = await launch(); await first.wait((m) => m.type === "ready");
  assert.equal((await fetch(`${first.origin}/readyz`)).status, 200);
  await first.command("pause");
  const before = await first.command("state");
  phase = "independent stale detection";
  const stale = await poll(() => first.command("state"), (state) => state.health.worker.heartbeat === "stale");
  assert.equal(stale.health.ready, false);
  assert.equal(stale.samples.find((s) => s.id === "worker").sequence, before.samples.find((s) => s.id === "worker").sequence);
  assert.ok(stale.samples.find((s) => s.id === "poll").sequence > before.samples.find((s) => s.id === "poll").sequence);
  assert.equal((await fetch(`${first.origin}/readyz`)).status, 503);
  assert.equal((await fetch(`${first.origin}/healthz`)).status, 200);
  const duplicate = await launch();
  const refusal = await duplicate.wait((m) => m.type === "refused"); assert.match(refusal.error, /Another worker/);
  assert.equal((await duplicate.exited).code, 1);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  async function login(origin) {
    await page.goto(origin);
    await page.getByLabel("User ID").or(page.getByTestId("worker-readiness")).first().waitFor();
    if (await page.getByLabel("User ID").isVisible()) {
      await page.getByLabel("User ID").fill("owner"); await page.getByLabel("Access secret").fill(secret);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
    await page.getByTestId("worker-readiness").waitFor();
  }
  await login(first.origin);
  assert.equal(await page.getByTestId("worker-heartbeat").innerText(), "stale");
  assert.equal(await page.getByTestId("worker-readiness").innerText(), "Not ready");
  await page.locator(".monitorAlerts summary").click();
  await page.getByText("Heartbeat stale: open", { exact: true }).waitFor();
  await page.getByLabel("Worker monitoring", { exact: true }).screenshot({ path: resolve(output, "monitoring-stale-desktop.png") });
  phase = "fresh but fenced recovery"; await first.command("resume");
  const fresh = await poll(() => first.command("state"), (state) => state.health.worker.heartbeat === "fresh" && state.alerts.some((a) => a.condition === "heartbeat_stale" && a.edge === "recovery"));
  assert.equal(fresh.health.ready, false);
  assert.deepEqual(fresh.alerts.filter((a) => a.condition === "heartbeat_stale").map((a) => a.edge), ["open", "recovery"]);
  await page.getByRole("button", { name: "Refresh monitoring", exact: true }).click();
  await page.getByText("Heartbeat stale: recovery", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("worker-phase").innerText(), "faulted");
  await first.command("stop"); assert.equal((await first.exited).code, 0);
  phase = "replacement ownership";
  const replacement = await launch(); await replacement.wait((m) => m.type === "ready");
  const restarted = await replacement.command("state"); assert.equal(restarted.health.ready, true);
  assert.notEqual(restarted.health.worker.session, fresh.health.worker.session);
  assert.deepEqual(restarted.alerts.filter((a) => a.condition === "worker_fault").map((a) => a.edge), ["open", "recovery"]);
  await replacement.command("seed"); const seeded = await replacement.command("state");
  await login(replacement.origin);
  phase = "approved retention UI";
  await page.getByText("Output retention", { exact: true }).click();
  await page.getByLabel("Output before (UTC)").fill("2026-10-02"); await page.getByLabel("Batch limit").fill("1");
  await page.getByRole("button", { name: "Request cleanup", exact: true }).click();
  await page.getByRole("button", { name: "Approve cleanup", exact: true }).waitFor();
  assert.equal((await replacement.command("state")).deltas.length, 1);
  await page.getByRole("button", { name: "Approve cleanup", exact: true }).click();
  await page.getByText(/Deleted 1 of 1 examined deltas/).waitFor();
  const pruned = await replacement.command("state"); assert.equal(pruned.deltas.length, 0); assert.equal(pruned.prunes.length, 1); assert.equal(pruned.protectedHash, seeded.protectedHash);
  phase = "responsive containment";
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.getByLabel("Worker monitoring", { exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const overflow = await page.locator(".monitoringBand").evaluate((section) => {
      const parent = section.getBoundingClientRect();
      return [...section.querySelectorAll("input, button, dd, p, summary, li")].filter((element) => element.getClientRects().length && (element.getBoundingClientRect().left < parent.left - 1 || element.getBoundingClientRect().right > parent.right + 1)).map((element) => element.tagName);
    });
    assert.deepEqual(overflow, []);
    await page.getByLabel("Worker monitoring", { exact: true }).screenshot({ path: resolve(output, `monitoring-${name}.png`) });
  }
  assert.deepEqual(errors, []);
  await replacement.command("stop"); assert.equal((await replacement.exited).code, 0);
  assert.equal(children.some((child) => child.logs().includes(secret)), false);
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, evidence: "Real child processes, actual HTTP/SQLite/Chromium, paused heartbeat writer with independent poller and exclusive owner lock. Synthetic retained-output fixture. Not live model or cloud monitoring.", before, stale, refusal, fresh, restarted, seeded, pruned, errors };
  await writeFile(resolve(output, "monitoring-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: "passed", report: resolve(output, "monitoring-report.json") }) + "\n");
} catch (error) {
  await writeFile(resolve(output, `monitoring-failure-${Date.now()}.json`), JSON.stringify({ phase, error: String(error), errors, logs: children.map((child) => child.logs()) }, null, 2)); throw error;
} finally {
  await browser?.close();
  for (const worker of children) { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await worker.exited; }
  await rm(directory, { recursive: true, force: true });
}
