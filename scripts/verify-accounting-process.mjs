import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = await mkdtemp(join(tmpdir(), "agent-r7-accounting-"));
const children = []; const output = resolve("artifacts/acceptance/R7"); let phase = "startup";
function launch(version) {
  const child = fork(resolve("scripts/fixtures/accounting-worker.mjs"), [join(directory, "runtime.sqlite"), version], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, DEEPSEEK_API_KEY: "" } });
  const messages = []; let logs = ""; let sequence = 0;
  child.on("message", (message) => messages.push(message)); child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  const wait = async (predicate) => { for (let i = 0; i < 200; i++) { const found = messages.find(predicate); if (found) return found; await delay(25); } throw new Error(`Worker response timeout: ${logs}`); };
  const command = async (command) => { const id = ++sequence; child.send({ id, command }); const response = await wait((message) => message.id === id); if (response.error) throw new Error(response.error); return response.result; };
  const worker = { child, messages, wait, command, exited }; children.push(worker); return worker;
}
try {
  await mkdir(output, { recursive: true });
  const first = launch("original"); await first.wait((message) => message.type === "ready");
  const runId = await first.command("run"); await first.wait((message) => message.type === "model-dispatched" && message.runId === runId);
  const before = await first.command("state"); const open = before.operations[0].observations.find((operation) => operation.start.details.kind === "llm");
  assert.ok(open); assert.equal(open.completion, null); assert.equal(open.start.details.price.rate.version, "original");
  phase = "kill during dispatched provider request";
  first.child.kill("SIGKILL"); assert.equal((await first.exited).signal, "SIGKILL");
  const second = launch("changed"); await second.wait((message) => message.type === "ready");
  const after = await second.command("state");
  const interrupted = after.operations[0].observations.find((operation) => operation.start.operationId === open.start.operationId);
  assert.deepEqual(interrupted.start, open.start); assert.equal(interrupted.completion.result.state, "interrupted");
  assert.equal(interrupted.completion.usage.kind, "unknown"); assert.equal(interrupted.completion.cost.kind, "unknown");
  assert.equal(interrupted.completion.result.endedAt, undefined); assert.equal(interrupted.completion.result.durationMs, undefined);
  assert.equal(after.runs[0].status, "failed"); assert.equal(after.runs[0].costUsd, null); assert.equal(after.runs[0].inputTokens, null);
  assert.equal(await second.command("run"), runId); await delay(100);
  assert.equal(second.messages.some((message) => message.type === "model-dispatched"), false);
  assert.equal((await second.command("state")).operations[0].observations.filter((operation) => operation.start.details.kind === "llm").length, 1);
  await second.command("stop"); assert.equal((await second.exited).code, 0);
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, evidence: "Real separate process killed after entering controlled provider transport, before any usage response. Restart persists interrupted unknown exposure and does not retry. No live API or billing claim.", runId, before, after };
  await writeFile(resolve(output, "accounting-process-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: "passed", runId, report: resolve(output, "accounting-process-report.json") }) + "\n");
} catch (error) { await writeFile(resolve(output, `accounting-process-failure-${Date.now()}.json`), JSON.stringify({ phase, error: String(error) }, null, 2)); throw error; }
finally {
  for (const worker of children) { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await worker.exited; }
  await rm(directory, { recursive: true, force: true });
}
