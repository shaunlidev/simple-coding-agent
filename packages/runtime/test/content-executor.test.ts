import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvironment } from "@simple-coding-agent/security";
import { SQLiteRuntimeStore, RuntimeScheduler, contentTaskSchema, createContentExecutor } from "../src/index.ts";

test("R6.5 explicit demo content tasks use shared admission and results without model/network fallback", async () => {
  const store = new SQLiteRuntimeStore();
  const task = contentTaskSchema.parse({ id: "demo-task", title: "Demo task", instruction: "Collect explicit fixtures", mode: "demo", model: "demo-faux", sources: [{ id: "mock", kind: "mock", url: "https://example.test/demo", query: "coding agent" }] });
  store.saveContentTask(task, 0);
  const scheduler = new RuntimeScheduler({ runtime: store, runAgent: createContentExecutor(store, { env: parseEnvironment({}), providerFactory: () => { throw new Error("Live provider must not be constructed for a demo task"); } }) });
  try {
    const runId = await scheduler.runTask(task.id, { actor: "owner", key: "demo" });
    await scheduler.idle();
    const detail = store.readRunDetail(runId);
    assert.equal(detail?.run.status, "completed");
    assert.equal(detail?.result?.items.length, 3);
    assert.equal(detail?.result?.provenance, "demo");
    assert.equal((await store.snapshot()).agent.mode, "demo");
    assert.ok(detail?.sources.every((source) => source.status === "ok" && source.documents.every((document) => document.representation === "demo_fixture")));
    assert.equal(store.memory.readContext(runId)?.context.practice, null);
  } finally { await scheduler.stop(); store.database.sqlite.close(); }
});

test("R6.5 live task without credentials fails, and production cannot execute a demo task", async () => {
  for (const mode of ["live", "demo"] as const) {
    const store = new SQLiteRuntimeStore();
    const task = contentTaskSchema.parse({ id: "task", title: "Task", instruction: "Read configured content", mode, model: mode === "demo" ? "demo-faux" : "deepseek-v4-pro", sources: mode === "demo" ? [{ id: "mock", kind: "mock", url: "https://example.test/demo" }] : [{ id: "url", kind: "url", url: "https://example.test/page" }] });
    store.saveContentTask(task, 0);
    const env = parseEnvironment(mode === "demo" ? { NODE_ENV: "production", DEEPSEEK_API_KEY: "synthetic-not-used", AGENT_SESSION_SECRET: "synthetic-session-secret-at-least-32-characters" } : {});
    const scheduler = new RuntimeScheduler({ runtime: store, runAgent: createContentExecutor(store, { env }) });
    try {
      const runId = await scheduler.runTask(task.id, { actor: "owner", key: "run" });
      await scheduler.idle();
      assert.equal((await store.projectRun(runId)).status, "failed");
      assert.equal(store.readRunResult(runId), undefined);
      assert.deepEqual(store.readSourceResults(runId), []);
      assert.ok((await store.listEvents(runId)).some((event) => event.type === "run.failed" && String(event.payload.detail).includes(mode === "demo" ? "disabled in production" : "DEEPSEEK_API_KEY")));
    } finally { await scheduler.stop(); store.database.sqlite.close(); }
  }
  assert.equal(contentTaskSchema.safeParse({ id: "fake-live", title: "Fake live", instruction: "Do not allow mixed provenance", sources: [{ id: "mock", kind: "mock", url: "https://example.test/demo" }] }).success, false);
});
