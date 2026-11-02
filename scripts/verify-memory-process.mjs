import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "r6-process-"));
const output = resolve("artifacts/acceptance/R6");
const secret = "synthetic-r6-process-operator-secret-32-characters";
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", DEEPSEEK_API_KEY: "", AGENT_DEMO_MODE: "0",
  AGENT_DB_PATH: join(root, "shared.sqlite"), AGENT_SERVER_HOST: "127.0.0.1", AGENT_SERVER_PORT: String(port), AGENT_PUBLIC_ORIGIN: origin, AGENT_CORS_ORIGIN: origin,
  AGENT_SESSION_SECRET: "synthetic-r6-process-session-secret-32-characters", AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret }]), AGENT_LOCAL_USER: "owner", AGENT_LOCAL_SECRET: secret };
const children = [];
const cli = (args) => execFileSync(process.execPath, [resolve("packages/coding-agent/dist/task-entry.js"), ...args, "--cwd", root], { env, encoding: "utf8", timeout: 30000 });
async function launch() {
  const child = spawn(process.execPath, [resolve("packages/server/dist/entry.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const read = (chunk) => { logs = `${logs}${chunk}`.slice(-20000); };
  child.stdout.on("data", read); child.stderr.on("data", read);
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  const worker = { child, exited }; children.push(worker);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`API process exited: ${logs}`);
    const healthy = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false);
    if (healthy) return worker;
    await delay(50);
  }
  throw new Error(`API did not start: ${logs}`);
}
async function stop(worker) {
  worker.child.kill("SIGTERM");
  const result = await Promise.race([worker.exited, delay(5000).then(() => { throw new Error("API failed to drain"); })]);
  assert.equal(result.code, 0);
}
async function login() {
  const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "owner", secret }) });
  assert.equal(response.status, 200);
  const session = await response.json();
  return { cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "), "x-csrf-token": session.csrfToken, "content-type": "application/json" };
}
let headers;
async function api(path, method = "GET", body, extraHeaders = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...headers, ...extraHeaders }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value)); return value;
}
async function run(key) {
  const { runId } = await api("/api/runs/run-now", "POST", { taskId: "persistent-task" }, { "idempotency-key": key });
  for (let attempt = 0; attempt < 200; attempt++) {
    const detail = await api(`/api/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(detail.run.status)) { assert.equal(detail.run.status, "completed"); return detail; }
    await delay(50);
  }
  throw new Error("Task did not complete");
}
try {
  await mkdir(output, { recursive: true });
  cli(["create", "persistent-task", "--source", "mock", "--query", "SQLite queues"]);
  const initial = await launch(); headers = await login();
  const first = await run("first");
  const item = first.result.items[0];
  const feedback = await api("/api/memory/feedback", "POST", { itemId: item.id, signal: "saved", requestKey: "saved-once" });
  const note = await api("/api/memory/entries", "POST", { kind: "knowledge", content: "SQLite queues need durable acceptance evidence", metadata: { url: "https://sqlite.org/wal.html" } });
  const version = await api("/api/memory/practices", "POST", { title: "Persistent quote policy", principle: "Use two distinct supporting quotes", rules: [{ kind: "minimum_quotes", count: 2 }], evidence: [{ kind: "feedback", feedbackId: feedback.feedback.id }] });
  await api(`/api/memory/practices/${version.id}/review`, "POST", { decision: "approved", reason: "Controlled persistence acceptance" });
  const evaluation = await api(`/api/memory/practices/${version.id}/evaluate`, "POST", {});
  assert.equal(evaluation.report.passed, true);
  await api(`/api/memory/practices/${version.id}/activate`, "POST", { evaluationId: evaluation.id, expectedRevision: 0, confirmation: "activate-practice" });
  const active = await run("active");
  assert.equal(active.memoryContext.context.knowledge[0].id, note.id);
  assert.equal(active.memoryContext.context.practice.id, version.id);
  assert.equal(active.result.items.find((value) => value.id === item.id).score, 68);
  const before = await api("/api/memory/export");
  await stop(initial);
  const listed = cli(["list"]);
  assert.match(listed, /persistent-task/);
  const terminal = cli(["run", "persistent-task"]);
  assert.match(terminal, /3 items/);
  const restarted = await launch(); headers = await login();
  const after = await api("/api/memory/export");
  assert.deepEqual(after, before);
  assert.deepEqual(await api(`/api/runs/${active.run.id}`), active);
  const latest = (await api("/api/runs")).runs[0];
  const terminalDetail = await api(`/api/runs/${latest.id}`);
  assert.notEqual(latest.id, active.run.id);
  assert.equal(terminalDetail.memoryContext.context.practice.id, version.id);
  assert.equal(terminalDetail.memoryContext.context.knowledge[0].id, note.id);
  assert.equal(terminalDetail.result.items.find((value) => value.id === item.id).score, 68);
  assert.ok(terminalDetail.result.items.every((value) => value.citations.length >= 2));
  await stop(restarted);
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, evidence: "Actual server entry processes and terminal subprocess, persistent SQLite, SIGTERM/restart, explicit demo task. Not live-model or cloud evidence.", before, after, active, terminalDetail };
  assert.equal(JSON.stringify(report).includes(secret), false);
  await writeFile(resolve(output, "process-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: "passed", report: resolve(output, "process-report.json"), runs: [active.run.id, latest.id] }) + "\n");
} finally {
  for (const worker of children) { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await worker.exited; }
  await rm(root, { recursive: true, force: true });
}
