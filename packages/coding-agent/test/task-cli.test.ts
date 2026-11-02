import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseTaskCliArgs, runTaskCli } from "../src/task-cli.ts";
import { openLocalTaskHost } from "@simple-coding-agent/runtime";
import { localEnv } from "./task-fixture.ts";
import { runNodeEntry } from "./process-harness.ts";

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "coding-agent-task-cli-"));
}

test("parseTaskCliArgs supports create, run, daemon, feedback, and preferences", () => {
  assert.deepEqual(parseTaskCliArgs(["create", "brief", "--every", "6h", "--source", "rss", "--url", "https://example.com/rss"]), {
    kind: "create",
    cwd: undefined,
    args: { id: "brief", title: undefined, every: "6h", source: "rss", url: "https://example.com/rss", query: undefined },
  });
  assert.deepEqual(parseTaskCliArgs(["run", "brief"]), { kind: "run", id: "brief", cwd: undefined });
  assert.deepEqual(parseTaskCliArgs(["daemon", "--interval-ms", "5", "--once"]), {
    kind: "daemon",
    cwd: undefined,
    intervalMs: 5,
    once: true,
  });
  assert.deepEqual(parseTaskCliArgs(["feedback", "brief", "item-1", "saved"]), {
    kind: "feedback",
    taskId: "brief",
    itemId: "item-1",
    signal: "saved",
    cwd: undefined,
  });
  assert.deepEqual(parseTaskCliArgs(["preferences", "--interests", "AI,coding", "--blocked-topics", "ads"]), {
    kind: "preferences",
    cwd: undefined,
    interests: ["AI", "coding"],
    blockedTopics: ["ads"],
  });
});

test("R6.5 task CLI create/list/run/feedback use the same SQLite across actual processes", async (t) => {
  const root = await createRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = { stdout: "", stderr: "" };
  const io = {
    stdout: { write: (chunk: string) => (output.stdout += chunk) },
    stderr: { write: (chunk: string) => (output.stderr += chunk) },
  };

  assert.equal(await runTaskCli(["create", "brief", "--cwd", root, "--every", "6h", "--source", "mock", "--query", "coding agent"], io, localEnv), 0);
  assert.equal(await runTaskCli(["list", "--cwd", root], io, localEnv), 0);
  const entry = fileURLToPath(new URL("../src/task-entry.ts", import.meta.url));
  const executed = await runNodeEntry(entry, ["run", "brief", "--cwd", root], { ...localEnv, AGENT_DB_PATH: "data/agent-ops.sqlite", NODE_ENV: "test" });
  assert.equal(executed.code, 0, executed.stderr);
  assert.match(executed.stdout, /Ran brief: 3 items/);
  const host = openLocalTaskHost({ workspaceRoot: root, env: localEnv });
  try {
    const run = (await host.store.listRuns())[0];
    const item = host.store.readRunResult(run.id)!.items[0];
    const response = await runNodeEntry(entry, ["feedback", "brief", item.id, "clicked", "--cwd", root], { ...localEnv, AGENT_DB_PATH: "data/agent-ops.sqlite", NODE_ENV: "test" });
    assert.equal(response.code, 0, response.stderr);
    assert.equal(host.store.memory.feedback()[0].signal, "clicked");
    assert.equal(host.store.listContentTasks()[0].definition.id, "brief");
  } finally { await host.close(); }
  assert.equal(output.stdout.includes("Created task brief"), true);
  assert.equal(output.stderr, "");
  assert.equal(await runTaskCli(["list", "--cwd", root], io, {}), 1);
  assert.match(output.stderr, /Local authentication failed/);
});
