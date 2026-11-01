import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTaskCliArgs, runTaskCli } from "../src/task-cli.ts";

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

test("task CLI create, list, run, and feedback use durable docs/agent files", async () => {
  const root = await createRoot();
  const output = { stdout: "", stderr: "" };
  const io = {
    stdout: { write: (chunk: string) => (output.stdout += chunk) },
    stderr: { write: (chunk: string) => (output.stderr += chunk) },
  };

  assert.equal(await runTaskCli(["create", "brief", "--cwd", root, "--every", "6h", "--source", "mock", "--query", "coding agent"], io), 0);
  assert.equal(await runTaskCli(["list", "--cwd", root], io), 0);
  assert.equal(await runTaskCli(["run", "brief", "--cwd", root], io), 0);
  assert.equal(await runTaskCli(["feedback", "brief", "example.test-agent-runtime-events", "clicked", "--cwd", root], io), 0);

  const tasks = JSON.parse(new TextDecoder().decode(await readFile(join(root, "docs/agent/schedules/tasks.json"))));
  const events = new TextDecoder().decode(await readFile(join(root, "docs/agent/events/queue.jsonl")));
  const feedback = new TextDecoder().decode(await readFile(join(root, "docs/agent/memory/feedback.jsonl")));

  assert.equal(tasks.tasks[0].id, "brief");
  assert.equal(output.stdout.includes("Created task brief"), true);
  assert.equal(output.stdout.includes("Ran brief: 3 items"), true);
  assert.equal(events.includes('"delivery_created"'), true);
  assert.equal(feedback.includes('"clicked"'), true);
  assert.equal(output.stderr, "");
});
