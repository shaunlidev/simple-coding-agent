import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  workflowCaptureRequirement,
  workflowCreatePlan,
  workflowListBacklog,
  workflowRecordVerification,
} from "../src/workflow.ts";

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "coding-agent-workflow-"));
}

async function readText(path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(path));
}

test("workflow capture writes inbox, backlog, and spec files", async () => {
  const root = await createRoot();
  const result = await workflowCaptureRequirement(
    {
      title: "Browser acceptance smoke",
      description: "Verify a web app through browser tools before completing UI work.",
      acceptanceCriteria: ["Browser can navigate to local app", "Snapshot contains expected heading"],
      priority: 1,
    },
    { allowedRoot: root },
  );

  assert.equal(result.includes("Captured requirement"), true);
  const backlog = JSON.parse(await readText(join(root, "docs/agent/backlog.json")));
  const inbox = JSON.parse(await readText(join(root, "docs/agent/inbox.json")));
  assert.equal(backlog.items[0].title, "Browser acceptance smoke");
  assert.equal(inbox.items[0].priority, 1);

  const spec = await readText(join(root, "docs/agent/specs", `${backlog.items[0].id}.md`));
  assert.equal(spec.includes("# Browser acceptance smoke"), true);
  assert.equal(spec.includes("- Snapshot contains expected heading"), true);
});

test("workflow creates a self-contained active plan from backlog", async () => {
  const root = await createRoot();
  await workflowCaptureRequirement(
    {
      title: "Rank requirements",
      description: "Keep requirements sorted by priority before implementation.",
      acceptanceCriteria: ["Backlog output is sorted"],
      priority: 2,
    },
    { allowedRoot: root },
  );

  const list = await workflowListBacklog({ allowedRoot: root });
  assert.equal(list.includes("Rank requirements"), true);

  const result = await workflowCreatePlan({}, { allowedRoot: root });
  assert.equal(result.includes("Created plan"), true);
  const backlog = JSON.parse(await readText(join(root, "docs/agent/backlog.json")));
  const plan = await readText(join(root, "docs/agent/plans/active", `${backlog.items[0].id}.md`));

  assert.equal(backlog.items[0].status, "planned");
  assert.equal(plan.includes("## Goal"), true);
  assert.equal(plan.includes("- Backlog output is sorted"), true);
  assert.equal(plan.includes("## Verification"), true);
});

test("workflow records verification evidence", async () => {
  const root = await createRoot();
  const result = await workflowRecordVerification(
    {
      id: "feature-a",
      summary: "All local gates passed.",
      commands: ["npm run test"],
      result: "passed",
    },
    { allowedRoot: root },
  );

  assert.equal(result, "Recorded verification feature-a: passed");
  const evidence = await readText(join(root, "docs/agent/evidence/feature-a.md"));
  assert.equal(evidence.includes("All local gates passed."), true);
  assert.equal(evidence.includes("`npm run test`"), true);
});
