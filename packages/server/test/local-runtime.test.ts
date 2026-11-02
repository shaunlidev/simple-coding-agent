import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScheduledTask, listScheduledTasks, runScheduledTask, updatePreferences } from "../../coding-agent/src/tasks.ts";
import { createAuthenticatedServer, authEnv, operatorSecret } from "./auth-fixture.ts";

test("R6.5 API and terminal share tasks, feedback, preferences and execution ownership across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "api-terminal-")); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...authEnv, AGENT_DEMO_MODE: "0", AGENT_DB_PATH: join(root, "shared.sqlite"), AGENT_LOCAL_USER: "owner", AGENT_LOCAL_SECRET: operatorSecret };
  const cli = { allowedRoot: root, env };
  await createScheduledTask({ id: "from-terminal", source: "mock", every: "6h" }, cli);
  const first = await runScheduledTask("from-terminal", cli);
  const item = first.topItems[0];
  const server = await createAuthenticatedServer({ env, startScheduler: true });
  try {
    const tasks = (await server.request({ method: "GET", url: "/api/tasks" })).json().tasks;
    assert.deepEqual(tasks.map((task: { definition: { id: string } }) => task.definition.id), ["from-terminal"]);
    const definition = { ...tasks[0].definition, id: "from-api", title: "API-created task" };
    assert.equal((await server.request({ method: "PUT", url: "/api/tasks/from-api", payload: { definition, expectedRevision: 0 } })).statusCode, 200);
    assert.deepEqual((await listScheduledTasks(cli)).map((task) => task.id), ["from-api", "from-terminal"]);
    await updatePreferences(cli, { interests: ["reliable queues"] });
    const memory = await server.request({ method: "GET", url: "/api/memory/export" });
    assert.equal(memory.statusCode, 200);
    assert.deepEqual(memory.json().memory.interests, ["reliable queues"]);
    assert.equal((await server.request({ method: "POST", url: "/api/memory/feedback", payload: { itemId: item.id, signal: "saved" } })).statusCode, 200);
    await assert.rejects(runScheduledTask("from-terminal", cli), /Another worker owns/);
  } finally { await server.app.close(); server.database.sqlite.close(); }
  const next = await runScheduledTask("from-terminal", cli);
  assert.equal(next.topItems.find((entry) => entry.id === item.id)?.score, item.score + 18);
  const reopened = await createAuthenticatedServer({ env });
  try {
    const detail = (await reopened.request({ method: "GET", url: `/api/runs/${next.runId}` })).json();
    assert.equal(detail.result.items.find((entry: { id: string }) => entry.id === item.id).score, item.score + 18);
    assert.equal(detail.memoryContext.context.feedback[0].actor, "owner");
    assert.equal(detail.task.definition.id, "from-terminal");
  } finally { await reopened.app.close(); reopened.database.sqlite.close(); }
});
