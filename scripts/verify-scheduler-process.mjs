import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = await mkdtemp(join(tmpdir(), "agent-r5-process-"));
const children = [];
function launch() {
  const child = fork(resolve("scripts/fixtures/scheduler-worker.mjs"), [join(directory, "runtime.sqlite")], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, DEEPSEEK_API_KEY: "" } });
  const messages = []; let logs = ""; let sequence = 0;
  child.on("message", (message) => messages.push(message));
  child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  const wait = async (predicate) => {
    for (let index = 0; index < 200; index++) { const value = messages.find(predicate); if (value) return value; await delay(25); }
    throw new Error(`Worker message timeout: ${logs}`);
  };
  const command = async (command, data = {}) => { const id = ++sequence; child.send({ id, command, ...data }); const reply = await wait((message) => message.id === id); if (reply.error) throw new Error(reply.error); return reply.result; };
  const worker = { child, messages, wait, command, exited }; children.push(worker); return worker;
}
try {
  const first = launch(); await first.wait((message) => message.type === "ready");
  const firstId = await first.command("run", { key: "first" });
  await first.wait((message) => message.type === "started" && message.runId === firstId);
  const secondId = await first.command("run", { key: "second" });
  const thirdId = await first.command("run", { key: "third" });
  const before = await first.command("state");
  assert.deepEqual(before.jobs.map((job) => job.state), ["running", "queued", "queued"]);
  const duplicate = launch(); const refusal = await duplicate.wait((message) => message.type === "refused");
  assert.match(refusal.error, /Another worker/); assert.equal((await duplicate.exited).code, 1);
  first.child.kill("SIGKILL"); assert.equal((await first.exited).signal, "SIGKILL");
  const recovered = launch(); await recovered.wait((message) => message.type === "ready");
  await recovered.wait((message) => message.type === "started" && message.runId === secondId);
  assert.equal(await recovered.command("run", { key: "second" }), secondId);
  await recovered.command("release", { runId: secondId });
  await recovered.wait((message) => message.type === "started" && message.runId === thirdId);
  await recovered.command("release", { runId: thirdId });
  let after;
  for (let index = 0; index < 100; index++) { after = await recovered.command("state"); if (after.jobs[2].state === "completed") break; await delay(25); }
  const output = resolve("artifacts/acceptance/R5"); await mkdir(output, { recursive: true });
  if (after.jobs[2].state !== "completed") await writeFile(resolve(output, `process-failure-${Date.now()}.json`), JSON.stringify(after, null, 2));
  assert.deepEqual(after.jobs.map((job) => job.state), ["failed", "completed", "completed"], JSON.stringify(after.failures));
  assert.deepEqual(after.jobs.map((job) => job.run_id), [firstId, secondId, thirdId]);
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(after.schedules[0].nextRunAt, before.schedules[0].nextRunAt);
  assert.deepEqual(recovered.messages.filter((message) => message.type === "started").map((message) => message.runId), [secondId, thirdId]);
  await recovered.command("stop"); assert.equal((await recovered.exited).code, 0);
  const report = { checkedAt: new Date().toISOString(), source: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }, evidence: "Real separate worker processes, exclusive SQLite lock, SIGKILL and restart; controlled provider/network, not live model or cloud", refusal, before, after };
  await writeFile(resolve(output, "process-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: "passed", runIds: [firstId, secondId, thirdId], report: resolve(output, "process-report.json") }) + "\n");
} finally {
  for (const worker of children) { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL"); await worker.exited; }
  await rm(directory, { recursive: true, force: true });
}
