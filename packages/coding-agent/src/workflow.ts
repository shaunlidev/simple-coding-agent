import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "../../ai/dist/index.js";

export type WorkflowRuntimeOptions = {
  allowedRoot: string;
};

export type RequirementRecord = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  status: "inbox" | "planned" | "done";
  createdAt: string;
};

export type BacklogRecord = {
  items: RequirementRecord[];
};

export type WorkflowCaptureRequirementArgs = {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  priority?: number;
};

export type WorkflowCreatePlanArgs = {
  id?: string;
  title?: string;
  problem?: string;
  acceptanceCriteria?: string[];
};

export type WorkflowRecordVerificationArgs = {
  id: string;
  summary: string;
  commands?: string[];
  result: "passed" | "failed" | "blocked";
};

const WORKFLOW_ROOT = "docs/agent";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "requirement";
}

function now(): string {
  return new Date().toISOString();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeCriteria(value: unknown): string[] {
  if (value === undefined) return ["Acceptance criteria must be filled before implementation."];
  if (!Array.isArray(value)) throw new Error("acceptanceCriteria must be an array of strings");
  const criteria = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return criteria.length === 0 ? ["Acceptance criteria must be filled before implementation."] : criteria;
}

function workflowPath(runtime: WorkflowRuntimeOptions, ...parts: string[]): string {
  return join(runtime.allowedRoot, WORKFLOW_ROOT, ...parts);
}

async function readBacklog(runtime: WorkflowRuntimeOptions): Promise<BacklogRecord> {
  try {
    return JSON.parse(new TextDecoder().decode(await readFile(workflowPath(runtime, "backlog.json")))) as BacklogRecord;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { items: [] };
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function renderSpec(record: RequirementRecord): string {
  return `# ${record.title}

## Requirement

${record.description}

## Acceptance Criteria

${record.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}

## Priority

${record.priority}

## Status

${record.status}
`;
}

function renderPlan(record: Pick<RequirementRecord, "id" | "title" | "description" | "acceptanceCriteria">): string {
  return `# ${record.title}

## Goal

${record.description}

## Acceptance Criteria

${record.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}

## Plan

1. Inspect the relevant code and documentation.
2. Implement the smallest slice that satisfies the acceptance criteria.
3. Add or update deterministic tests.
4. Run targeted verification and record evidence.
5. Update documentation if user-visible behavior changes.

## Verification

- Run targeted tests for changed behavior.
- Run project gates when the change touches shared behavior.
- Record command outputs in \`docs/agent/evidence/${record.id}.md\`.

## Decision Log

- Created from workflow requirement \`${record.id}\`.
`;
}

export async function workflowCaptureRequirement(
  args: WorkflowCaptureRequirementArgs,
  runtime: WorkflowRuntimeOptions,
): Promise<string> {
  const title = requireString(args.title, "title");
  const description = requireString(args.description, "description");
  const id = `${new Date().toISOString().slice(0, 10)}-${slugify(title)}`;
  const record: RequirementRecord = {
    id,
    title,
    description,
    acceptanceCriteria: normalizeCriteria(args.acceptanceCriteria),
    priority: args.priority ?? 3,
    status: "inbox",
    createdAt: now(),
  };

  const backlog = await readBacklog(runtime);
  const next = { items: [...backlog.items.filter((item) => item.id !== id), record].sort((a, b) => a.priority - b.priority) };
  await writeJson(workflowPath(runtime, "inbox.json"), { items: next.items.filter((item) => item.status === "inbox") });
  await writeJson(workflowPath(runtime, "backlog.json"), next);
  await writeText(workflowPath(runtime, "specs", `${id}.md`), renderSpec(record));
  return `Captured requirement ${id}`;
}

export async function workflowListBacklog(runtime: WorkflowRuntimeOptions): Promise<string> {
  const backlog = await readBacklog(runtime);
  if (backlog.items.length === 0) return "Backlog is empty";
  return backlog.items
    .map((item) => `${item.priority}. ${item.id} [${item.status}] ${item.title}`)
    .join("\n");
}

export async function workflowCreatePlan(args: WorkflowCreatePlanArgs, runtime: WorkflowRuntimeOptions): Promise<string> {
  const backlog = await readBacklog(runtime);
  const existing = args.id ? backlog.items.find((item) => item.id === args.id) : backlog.items[0];
  const fallbackTitle = args.title ? requireString(args.title, "title") : undefined;
  const record = existing ?? {
    id: `${new Date().toISOString().slice(0, 10)}-${slugify(fallbackTitle ?? "plan")}`,
    title: fallbackTitle ?? "Implementation Plan",
    description: requireString(args.problem, "problem"),
    acceptanceCriteria: normalizeCriteria(args.acceptanceCriteria),
  };

  await writeText(workflowPath(runtime, "plans", "active", `${record.id}.md`), renderPlan(record));
  if (existing) {
    const next = {
      items: backlog.items.map((item) => (item.id === existing.id ? { ...item, status: "planned" as const } : item)),
    };
    await writeJson(workflowPath(runtime, "backlog.json"), next);
  }
  return `Created plan ${record.id}`;
}

export async function workflowRecordVerification(
  args: WorkflowRecordVerificationArgs,
  runtime: WorkflowRuntimeOptions,
): Promise<string> {
  const id = requireString(args.id, "id");
  const summary = requireString(args.summary, "summary");
  if (args.result !== "passed" && args.result !== "failed" && args.result !== "blocked") {
    throw new Error("result must be passed, failed, or blocked");
  }
  const commands = args.commands ?? [];
  await writeText(
    workflowPath(runtime, "evidence", `${id}.md`),
    `# Verification ${id}

## Result

${args.result}

## Summary

${summary}

## Commands

${commands.length === 0 ? "- No commands recorded" : commands.map((command) => `- \`${command}\``).join("\n")}
`,
  );
  return `Recorded verification ${id}: ${args.result}`;
}

export function createWorkflowTools(runtime: WorkflowRuntimeOptions): ToolDefinition[] {
  return [
    {
      name: "workflow_capture_requirement",
      description: "Capture a requirement into docs/agent inbox, backlog, and a spec file before implementation",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description"],
        properties: {
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          priority: { type: "number", minimum: 1 },
        },
      },
      execute: (args) => workflowCaptureRequirement(args as WorkflowCaptureRequirementArgs, runtime),
    },
    {
      name: "workflow_list_backlog",
      description: "List captured requirements sorted by priority",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: () => workflowListBacklog(runtime),
    },
    {
      name: "workflow_create_plan",
      description: "Create a self-contained active implementation plan from a requirement or standalone problem statement",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          problem: { type: "string", minLength: 1 },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
        },
      },
      execute: (args) => workflowCreatePlan(args as WorkflowCreatePlanArgs, runtime),
    },
    {
      name: "workflow_record_verification",
      description: "Record verification evidence for a workflow item",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id", "summary", "result"],
        properties: {
          id: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          commands: { type: "array", items: { type: "string" } },
          result: { type: "string", minLength: 1 },
        },
      },
      execute: (args) => workflowRecordVerification(args as WorkflowRecordVerificationArgs, runtime),
    },
  ];
}
