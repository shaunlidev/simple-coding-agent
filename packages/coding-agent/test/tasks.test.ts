import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalTaskHost } from "@simple-coding-agent/runtime";
import type { SafeNetwork } from "@simple-coding-agent/security";
import { createDemoContentProvider } from "../../runtime/src/demo-content.ts";
import { createScheduledTask, listScheduledTasks, recordTaskFeedback, runDueTasks, runScheduledTask, runTaskDaemon, updatePreferences } from "../src/tasks.ts";
import { importLegacyTasks } from "../src/legacy-task-import.ts";
import { fixtureNetwork, localEnv } from "./task-fixture.ts";

test("R6.5 task commands persist shared receipts and unique digests without old JSON writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-tasks-")); t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { allowedRoot: root, env: localEnv, now: new Date("2026-08-25T01:00:00.000Z") };
  await createScheduledTask({ id: "daily social brief", title: "Daily Social Brief", every: "6h", source: "mock", query: "coding agent" }, runtime);
  const task = (await listScheduledTasks(runtime))[0];
  assert.equal(task.id, "daily-social-brief"); assert.equal(task.mode, "demo"); assert.equal(task.nextRunAt, "2026-08-25T07:00:00.000Z");
  const result = await runScheduledTask(task.id, runtime);
  const firstDigest = await readFile(result.digestPath, "utf8");
  const second = await runScheduledTask(task.id, runtime);
  assert.equal(result.itemCount, 3); assert.notEqual(result.digestPath, second.digestPath);
  assert.equal(await readFile(result.digestPath, "utf8"), firstDigest);
  assert.match(firstDigest, /# Daily Social Brief/); assert.match(firstDigest, /Mode: demo/);
  assert.match(firstDigest, /coding agent runtime event queues/);
  assert.match(await readFile(second.digestPath, "utf8"), /New deliveries: 0/);
  await assert.rejects(access(join(root, "docs/agent/schedules/tasks.json")));
  const host = openLocalTaskHost({ workspaceRoot: root, env: localEnv });
  try {
    const detail = host.store.readRunDetail(result.runId);
    assert.equal(detail?.run.status, "completed"); assert.equal(detail?.result?.provenance, "demo");
    assert.equal(detail?.result?.deliveries.length, 3);
    assert.ok(detail?.events.some((event) => event.type === "agent.tool.completed"));
    assert.equal(host.scheduler.listJobs().length, 2);
  } finally { await host.close(); }
});

test("R6.5 only due schedules run; manual tasks never become automatic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-due-")); t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { allowedRoot: root, env: localEnv, now: new Date("2026-08-25T01:00:00.000Z") };
  await createScheduledTask({ id: "hourly", every: "1h", source: "mock" }, runtime);
  await createScheduledTask({ id: "manual", source: "mock" }, runtime);
  assert.equal((await runDueTasks({ ...runtime, now: new Date("2026-08-25T01:30:00.000Z") })).length, 0);
  assert.equal((await runDueTasks({ ...runtime, now: new Date("2026-08-25T02:00:00.000Z") })).length, 1);
  assert.equal((await runDueTasks({ ...runtime, now: new Date("2026-08-25T02:00:00.000Z") })).length, 0);
});

test("R6.5 feedback uses canonical content IDs, replaces influence and persists across hosts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-feedback-")); t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { allowedRoot: root, env: localEnv };
  await createScheduledTask({ id: "brief", source: "mock" }, runtime);
  await updatePreferences(runtime, { interests: ["browser automation"], blockedTopics: ["productivity"], sourceWeights: { mock: 1 } });
  const first = await runScheduledTask("brief", runtime);
  assert.match(first.topItems[0].title, /Browser automation/);
  const item = first.topItems[0];
  await recordTaskFeedback({ taskId: "brief", itemId: item.id, signal: "saved" }, runtime);
  await recordTaskFeedback({ taskId: "brief", itemId: item.id, signal: "saved" }, runtime);
  await recordTaskFeedback({ taskId: "brief", itemId: item.id, signal: "not_interested" }, runtime);
  await assert.rejects(recordTaskFeedback({ taskId: "wrong", itemId: item.id, signal: "saved" }, runtime), /does not belong/);
  const next = await runScheduledTask("brief", runtime);
  assert.equal(next.topItems.find((entry) => entry.id === item.id)?.score, 19);
  const host = openLocalTaskHost({ workspaceRoot: root, env: localEnv });
  try {
    assert.equal(host.store.memory.feedback().length, 1);
    assert.equal(host.store.database.sqlite.prepare("select * from feedback_history").all().length, 2);
    assert.deepEqual(host.store.memory.read().interests, ["browser automation"]);
    host.store.database.sqlite.exec("create trigger fail_preference before insert on memory_entries begin select raise(abort,'injected'); end");
    assert.throws(() => host.store.memory.replacePreferences({ interests: ["replacement"] }, "owner"), /injected/);
    assert.deepEqual(host.store.memory.read().interests, ["browser automation"]);
    assert.equal(host.store.memory.search("browser automation").length, 1);
  } finally { await host.close(); }
  await updatePreferences(runtime, { interests: [] });
  assert.deepEqual((await updatePreferences(runtime, {})).interests, []);
});

test("R6.5 identity, source, missing key and worker ownership fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-guards-")); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(listScheduledTasks({ allowedRoot: root, env: {} }), /Local authentication failed/);
  await assert.rejects(access(join(root, "data")));
  const runtime = { allowedRoot: root, env: localEnv, network: fixtureNetwork() };
  await assert.rejects(createScheduledTask({ id: "ambiguous" }, runtime), /explicit --source/);
  await assert.rejects(createScheduledTask({ id: "private", source: "url", url: "http://127.0.0.1" }, runtime), /policy/i);
  await createScheduledTask({ id: "live", source: "url", url: "https://source.test/page" }, runtime);
  await assert.rejects(runScheduledTask("live", runtime), /DEEPSEEK_API_KEY/);
  const viewer = { ...runtime, env: { ...localEnv, AGENT_LOCAL_USER: "reader", AGENT_LOCAL_SECRET: "synthetic-viewer-secret-over-32-characters" } };
  assert.equal((await listScheduledTasks(viewer)).length, 1);
  await assert.rejects(updatePreferences(viewer, { interests: [] }), /Operator permission/);
  const owner = openLocalTaskHost({ workspaceRoot: root, env: localEnv });
  try {
    await owner.scheduler.tick();
    await assert.rejects(runScheduledTask("live", runtime), /Another worker owns/);
    assert.equal((await listScheduledTasks(runtime)).length, 1);
  } finally { await owner.close(); }
});

test("R6.5 real RSS and browser tasks go through guarded collection and actual Agent loop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-sources-")); t.after(() => rm(root, { recursive: true, force: true }));
  let reads = 0;
  const runtime = { allowedRoot: root, env: localEnv, providerFactory: createDemoContentProvider,
    network: fixtureNetwork('<rss version="2.0"><channel><title>Signals</title><item><title>Reliable queues</title><link>https://source.test/article</link><description>A practical coding agent update about reliable queues and exact evidence for acceptance.</description></item></channel></rss>'),
    browser: async (network: SafeNetwork, url: string) => { await network.read(url); reads++; return { url, title: "Browser signals", text: "A practical coding agent update about reliable queues and exact evidence for acceptance.", links: [], blockedRequests: [] }; } };
  for (const source of ["rss", "browser"] as const) {
    await createScheduledTask({ id: source, source, url: `https://source.test/${source}` }, runtime);
    const run = await runScheduledTask(source, runtime);
    assert.equal(run.itemCount, 1);
    assert.match(await readFile(run.digestPath, "utf8"), /exact evidence for acceptance/);
  }
  assert.equal(reads, 1);
});

test("R6.5 daemon retains ownership between polls and drains on abort", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-daemon-")); t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let signalTick!: () => void;
  const ticked = new Promise<void>((resolve) => { signalTick = resolve; });
  const runtime = { allowedRoot: root, env: localEnv };
  const daemon = runTaskDaemon(runtime, { intervalMs: 10000, signal: controller.signal, onTick: signalTick });
  try { await ticked; await assert.rejects(runDueTasks(runtime), /Another worker owns/); }
  finally { controller.abort(); await daemon; }
  assert.deepEqual(await runDueTasks(runtime), []);
});

test("R6.5 explicit legacy import is atomic, idempotent, paused and preserves untrusted history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-import-")); t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { allowedRoot: root, env: localEnv };
  const old = join(root, "docs/agent");
  await mkdir(join(old, "schedules"), { recursive: true }); await mkdir(join(old, "memory"));
  const taskText = JSON.stringify({ version: 1, tasks: [{ id: "old brief", title: "Old brief", source: { kind: "mock" }, everyMs: 3600000, enabled: true, createdAt: "2026-08-25T01:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z" }] });
  await writeFile(join(old, "schedules/tasks.json"), taskText);
  await writeFile(join(old, "memory/preferences.json"), JSON.stringify({ interests: ["reliable agents"], blockedTopics: [], sourceWeights: {} }));
  await writeFile(join(old, "memory/feedback.jsonl"), '{"itemId":"old-slug","signal":"saved"}\n');
  assert.deepEqual(await listScheduledTasks(runtime), []);
  const interrupted = openLocalTaskHost({ workspaceRoot: root, env: localEnv });
  try {
    interrupted.store.database.sqlite.exec("create trigger fail_import before insert on legacy_task_imports begin select raise(abort,'injected-import'); end");
    await assert.rejects(importLegacyTasks(runtime), /injected-import/);
    assert.deepEqual(interrupted.store.listContentTasks(), []);
    assert.deepEqual(interrupted.store.readSchedulesSync(), []);
    assert.deepEqual(interrupted.store.memory.read().interests, []);
    interrupted.store.database.sqlite.exec("drop trigger fail_import");
  } finally { await interrupted.close(); }
  const first = await importLegacyTasks(runtime);
  assert.equal(first.quarantinedFeedback, 1); assert.equal(first.mapping[0].taskId, "old-brief");
  assert.deepEqual(await importLegacyTasks(runtime), first);
  assert.equal((await listScheduledTasks(runtime))[0].enabled, false);
  assert.equal(await readFile(join(old, "schedules/tasks.json"), "utf8"), taskText);
  const host = openLocalTaskHost({ workspaceRoot: root, env: localEnv });
  try { assert.deepEqual(host.store.memory.feedback(), []); assert.deepEqual(await host.store.listRuns(), []); }
  finally { await host.close(); }
  await writeFile(join(old, "memory/feedback.jsonl"), "changed\n");
  await assert.rejects(importLegacyTasks(runtime), /source changed/);
  assert.equal((await listScheduledTasks(runtime)).length, 1);
});

test("R6.5 task and schedule creation roll back as one operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shared-create-atomic-")); t.after(() => rm(root, { recursive: true, force: true }));
  const host = openLocalTaskHost({ workspaceRoot: root, env: localEnv });
  try {
    host.store.database.sqlite.exec("create trigger fail_schedule before insert on schedules begin select raise(abort,'injected-schedule'); end");
    await assert.rejects(createScheduledTask({ id: "atomic", source: "mock", every: "1h" }, { allowedRoot: root, env: localEnv }), /injected-schedule/);
    assert.deepEqual(host.store.listContentTasks(), []);
    assert.deepEqual(host.store.readSchedulesSync(), []);
  } finally { await host.close(); }
});
