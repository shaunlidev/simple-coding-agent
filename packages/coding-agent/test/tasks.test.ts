import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserAdapter } from "../src/browser-tools.ts";
import {
  createScheduledTask,
  listScheduledTasks,
  recordTaskFeedback,
  runDueTasks,
  runScheduledTask,
  updatePreferences,
} from "../src/tasks.ts";

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "coding-agent-tasks-"));
}

async function readText(path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(path));
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  return (await readText(path))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("scheduled task create and run writes schedules, events, runs, and digest", async () => {
  const root = await createRoot();
  const now = new Date("2026-08-25T01:00:00.000Z");
  await createScheduledTask(
    { id: "daily social brief", title: "Daily Social Brief", every: "6h", source: "mock", query: "coding agent" },
    { allowedRoot: root, now },
  );

  const task = (await listScheduledTasks({ allowedRoot: root }))[0];
  assert.equal(task.id, "daily-social-brief");
  assert.equal(task.nextRunAt, "2026-08-25T07:00:00.000Z");

  const result = await runScheduledTask("daily-social-brief", { allowedRoot: root, now });
  const events = await readJsonl(join(root, "docs/agent/events/queue.jsonl"));
  const runs = await readJsonl(join(root, "docs/agent/events/runs.jsonl"));
  const digest = await readText(result.digestPath);

  assert.equal(result.itemCount, 3);
  assert.deepEqual(events.map((event) => event.type), [
    "task_due",
    "fetch_started",
    "fetch_completed",
    "content_cleaned",
    "content_scored",
    "summary_created",
    "delivery_created",
  ]);
  assert.equal(runs[0].status, "passed");
  assert.equal(digest.includes("# Daily Social Brief"), true);
  assert.equal(digest.includes("coding agent runtime event queues"), true);
});

test("runDueTasks only runs enabled tasks whose nextRunAt is due", async () => {
  const root = await createRoot();
  await createScheduledTask(
    { id: "hourly", every: "1h", source: "mock" },
    { allowedRoot: root, now: new Date("2026-08-25T01:00:00.000Z") },
  );

  assert.equal((await runDueTasks({ allowedRoot: root, now: new Date("2026-08-25T01:30:00.000Z") })).length, 0);
  assert.equal((await runDueTasks({ allowedRoot: root, now: new Date("2026-08-25T02:00:00.000Z") })).length, 1);
});

test("feedback and preferences change item ranking without overwriting feedback history", async () => {
  const root = await createRoot();
  await createScheduledTask({ id: "brief", source: "mock", query: "coding agent" }, { allowedRoot: root });
  await updatePreferences(
    { allowedRoot: root },
    { interests: ["browser automation"], blockedTopics: ["productivity"], sourceWeights: { mock: 1 } },
  );

  const first = await runScheduledTask("brief", { allowedRoot: root, now: new Date("2026-08-25T01:00:00.000Z") });
  assert.equal(first.topItems[0].title.includes("Browser automation"), true);
  const generic = first.topItems.find((item) => item.title === "Generic productivity thread");
  assert.equal(generic !== undefined, true);
  if (!generic) throw new Error("Generic item missing");

  await recordTaskFeedback({ taskId: "brief", itemId: generic.id, signal: "saved" }, { allowedRoot: root });
  await recordTaskFeedback({ taskId: "brief", itemId: generic.id, signal: "not_interested" }, { allowedRoot: root });
  const feedback = await readJsonl(join(root, "docs/agent/memory/feedback.jsonl"));

  assert.equal(feedback.length, 2);
  assert.deepEqual(feedback.map((entry) => entry.signal), ["saved", "not_interested"]);
});

test("browser source collects a page snapshot into the content pipeline", async () => {
  const root = await createRoot();
  const calls: string[] = [];
  const adapter: BrowserAdapter = {
    async navigate(args) {
      calls.push(`navigate:${args.url}:${args.headless}`);
      return "ok";
    },
    async snapshot(args) {
      calls.push(`snapshot:${args?.maxTextLength}`);
      return {
        url: "http://127.0.0.1:3000/social.html",
        title: "Social Signals",
        text: "AI agent browser collection post with acceptance criteria and scheduler runtime notes.",
        elements: [
          { tag: "a", text: "AI agent browser collection practice", selector: "a:nth-of-type(1)" },
          { tag: "button", text: "Ignore", selector: "button:nth-of-type(1)" },
        ],
      };
    },
    async click() {
      throw new Error("unused");
    },
    async type() {
      throw new Error("unused");
    },
    async close() {
      calls.push("close");
      return "closed";
    },
  };

  await createScheduledTask(
    { id: "browser-brief", source: "browser", url: "http://127.0.0.1:3000/social.html" },
    { allowedRoot: root },
  );
  const result = await runScheduledTask("browser-brief", { allowedRoot: root, browserAdapter: adapter });
  const digest = await readText(result.digestPath);

  assert.deepEqual(calls, ["navigate:http://127.0.0.1:3000/social.html:true", "snapshot:8000", "close"]);
  assert.equal(result.itemCount, 1);
  assert.equal(digest.includes("AI agent browser collection practice"), true);
});
