import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, runAgentLoop, type AgentEvent } from "../packages/agent/src/index.ts";
import { createFauxProvider, type FauxResponse } from "../packages/ai/dist/faux-provider.js";
import type { Message } from "../packages/ai/dist/index.js";
import { createLocalTools } from "../packages/coding-agent/src/tools.ts";

type EvalArtifact = {
  prompt: string;
  transcript: Message[];
  toolEvents: AgentEvent[];
  finalOutput: string;
  workspacePath: string;
  error?: string;
};

function assistantText(messages: readonly Message[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") return "";
  return assistant.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function createArtifact(prompt: string, agent: Agent, toolEvents: AgentEvent[], workspacePath: string, error?: string): EvalArtifact {
  const transcript = agent.snapshot().messages;
  return {
    prompt,
    transcript,
    toolEvents,
    finalOutput: assistantText(transcript),
    workspacePath,
    ...(error === undefined ? {} : { error }),
  };
}

async function createEvalAgent(
  responses: readonly FauxResponse[],
  options: { workspacePath?: string; maxTurns?: number } = {},
): Promise<{ agent: Agent; toolEvents: AgentEvent[]; workspacePath: string }> {
  const workspacePath = options.workspacePath ?? await mkdtemp(join(tmpdir(), "simple-agent-eval-"));
  const handle = createFauxProvider({ responses });
  const agent = new Agent({
    provider: handle.provider,
    tools: createLocalTools({ allowedRoot: workspacePath }),
    maxTurns: options.maxTurns,
  });
  const toolEvents: AgentEvent[] = [];
  agent.subscribe((event) => {
    if (event.type === "tool_start" || event.type === "tool_end") toolEvents.push(event);
  });
  return { agent, toolEvents, workspacePath };
}

async function runTaskEval(prompt: string, responses: readonly FauxResponse[], options: { maxTurns?: number } = {}): Promise<EvalArtifact> {
  const { agent, toolEvents, workspacePath } = await createEvalAgent(responses, options);
  try {
    await agent.prompt(prompt);
    return createArtifact(prompt, agent, toolEvents, workspacePath);
  } catch (error) {
    return createArtifact(prompt, agent, toolEvents, workspacePath, error instanceof Error ? error.message : String(error));
  }
}

test("eval reads a file and answers from tool output", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "simple-agent-eval-"));
  await writeFile(join(workspacePath, "note.txt"), "alpha");
  const { agent, toolEvents } = await createEvalAgent(
    [
      {
        type: "success",
        stopReason: "tool_call",
        content: [{ type: "tool_call", id: "read-1", name: "read", arguments: { path: "note.txt" } }],
      },
      "token: alpha",
    ],
    { workspacePath },
  );

  await agent.prompt("Read note.txt and answer with its token");
  const artifact = createArtifact("Read note.txt and answer with its token", agent, toolEvents, workspacePath);

  assert.equal(artifact.toolEvents.some((event) => event.type === "tool_start" && event.toolCall.name === "read"), true);
  assert.equal(artifact.finalOutput, "token: alpha");
  assert.equal(artifact.prompt.includes("Read note.txt"), true);
  assert.equal(artifact.transcript.length > 0, true);
  assert.equal(artifact.workspacePath.length > 0, true);
});

test("eval edits a file with exact expected diff", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "simple-agent-eval-"));
  await writeFile(join(workspacePath, "file.txt"), "one\nold\nthree\n");
  const { agent, toolEvents } = await createEvalAgent(
    [
      {
        type: "success",
        stopReason: "tool_call",
        content: [
          {
            type: "tool_call",
            id: "edit-1",
            name: "edit",
            arguments: { path: "file.txt", oldText: "old", newText: "new" },
          },
        ],
      },
      "edited",
    ],
    { workspacePath },
  );

  await agent.prompt("Replace old with new in file.txt");
  const artifact = createArtifact("Replace old with new in file.txt", agent, toolEvents, workspacePath);
  const after = new TextDecoder().decode(await readFile(join(workspacePath, "file.txt")));

  assert.equal(after, "one\nnew\nthree\n");
  assert.equal(artifact.finalOutput, "edited");
  assert.equal(artifact.toolEvents.some((event) => event.type === "tool_end" && event.message.toolName === "edit"), true);
});

test("eval rejects path escape and recovers with an explanation", async () => {
  const artifact = await runTaskEval("Try reading outside the workspace and explain the result", [
    {
      type: "success",
      stopReason: "tool_call",
      content: [{ type: "tool_call", id: "read-escape", name: "read", arguments: { path: "../secret.txt" } }],
    },
    "The path was rejected.",
  ]);

  assert.equal(artifact.toolEvents.some((event) => event.type === "tool_end" && event.message.isError), true);
  assert.equal(artifact.finalOutput, "The path was rejected.");
});

test("eval handles tool error and recovers", async () => {
  const artifact = await runTaskEval("Read missing.txt and report the failure", [
    {
      type: "success",
      stopReason: "tool_call",
      content: [{ type: "tool_call", id: "read-missing", name: "read", arguments: { path: "missing.txt" } }],
    },
    "missing.txt could not be read.",
  ]);

  assert.equal(artifact.toolEvents.some((event) => event.type === "tool_end" && event.message.isError), true);
  assert.equal(artifact.finalOutput, "missing.txt could not be read.");
});

test("eval stops on max turns", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "simple-agent-eval-"));
  const handle = createFauxProvider({
    responses: [
      {
        type: "success",
        stopReason: "tool_call",
        content: [{ type: "tool_call", id: "read-1", name: "read", arguments: { path: "missing.txt" } }],
      },
    ],
  });
  const stream = runAgentLoop("Loop forever", {
    provider: handle.provider,
    tools: createLocalTools({ allowedRoot: workspacePath }),
    maxTurns: 1,
  });
  const resultPromise = stream.result();
  const toolEvents: AgentEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of stream) {
      if (event.type === "tool_start" || event.type === "tool_end") toolEvents.push(event);
    }
  }, /Agent loop exceeded maxTurns 1/);
  await assert.rejects(resultPromise, /Agent loop exceeded maxTurns 1/);

  const artifact: EvalArtifact = {
    prompt: "Loop forever",
    transcript: [],
    toolEvents,
    finalOutput: "",
    workspacePath,
    error: "Agent loop exceeded maxTurns 1",
  };

  assert.equal(artifact.error, "Agent loop exceeded maxTurns 1");
  assert.equal(artifact.workspacePath.length > 0, true);
});
