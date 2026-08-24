import assert from "node:assert/strict";
import test from "node:test";
import { EventStream } from "../../ai/dist/event-stream.js";
import { createFauxProvider } from "../../ai/dist/faux-provider.js";
import type { AssistantMessage, JsonObject, Provider, StreamEvent, ToolDefinition } from "../../ai/dist/index.js";
import { Agent, runAgentLoop } from "../src/index.ts";

type ReadArgs = JsonObject & { path: string };

const readTool: ToolDefinition<ReadArgs> = {
  name: "read",
  description: "Read a file",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
    },
  },
  execute(args) {
    return `contents:${args.path}`;
  },
};

async function runLoop(provider: Provider, tools: readonly ToolDefinition<JsonObject>[] = []) {
  const stream = runAgentLoop("do it", { provider, tools, maxTurns: 4 });
  const events = [];

  for await (const event of stream) {
    events.push(event);
  }

  return {
    events,
    result: await stream.result(),
  };
}

test("text-only prompt returns final assistant message and lifecycle events", async () => {
  const handle = createFauxProvider({ responses: ["done"] });

  const { events, result } = await runLoop(handle.provider);

  assert.deepEqual(events.map((event) => event.type), [
    "agent_start",
    "turn_start",
    "provider_event",
    "provider_event",
    "provider_event",
    "provider_event",
    "provider_event",
    "agent_end",
  ]);
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(result.assistant.content, [{ type: "text", text: "done" }]);
  assert.equal(handle.pendingResponses(), 0);
});

test("tool prompt follows user assistant tool assistant trace", async () => {
  const handle = createFauxProvider({
    responses: [
      {
        type: "success",
        content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "README.md" } }],
      },
      "read complete",
    ],
  });

  const { result } = await runLoop(handle.provider, [readTool as ToolDefinition<JsonObject>]);

  assert.deepEqual(result.messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  assert.deepEqual(result.messages[2], {
    role: "tool",
    toolCallId: "call-1",
    toolName: "read",
    content: "contents:README.md",
  });
  assert.deepEqual(result.assistant.content, [{ type: "text", text: "read complete" }]);
});

test("known tool runtime failure becomes an error tool message", async () => {
  const brokenTool: ToolDefinition<JsonObject> = {
    ...readTool,
    execute() {
      throw new Error("disk unavailable");
    },
  };
  const handle = createFauxProvider({
    responses: [
      {
        type: "success",
        content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "README.md" } }],
      },
      "handled",
    ],
  });

  const { result } = await runLoop(handle.provider, [brokenTool]);

  assert.deepEqual(result.messages[2], {
    role: "tool",
    toolCallId: "call-1",
    toolName: "read",
    content: "disk unavailable",
    isError: true,
  });
});

test("unknown tool fails the agent runtime", async () => {
  const handle = createFauxProvider({
    responses: [
      {
        type: "success",
        content: [{ type: "tool_call", id: "call-1", name: "missing", arguments: {} }],
      },
    ],
  });
  const stream = runAgentLoop("do it", { provider: handle.provider, tools: [], maxTurns: 2 });
  const drainPromise = (async () => {
    for await (const _ of stream) {
      // drain events until failure
    }
  })();
  const resultPromise = stream.result();

  await assert.rejects(drainPromise, /Unknown tool "missing"/);
  await assert.rejects(resultPromise, /Unknown tool "missing"/);
});

test("max-turn guard prevents infinite tool loops", async () => {
  const handle = createFauxProvider({
    responses: [
      {
        type: "success",
        content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "a" } }],
      },
      {
        type: "success",
        content: [{ type: "tool_call", id: "call-2", name: "read", arguments: { path: "b" } }],
      },
    ],
  });
  const stream = runAgentLoop("loop", {
    provider: handle.provider,
    tools: [readTool as ToolDefinition<JsonObject>],
    maxTurns: 1,
  });
  const drainPromise = (async () => {
    for await (const _ of stream) {
      // drain events until failure
    }
  })();
  const resultPromise = stream.result();

  await assert.rejects(drainPromise, /exceeded maxTurns 1/);
  await assert.rejects(resultPromise, /exceeded maxTurns 1/);
});

test("provider async failure becomes a clean assistant error and agent_end", async () => {
  const provider: Provider = {
    id: "broken",
    name: "Broken Provider",
    models: [{ id: "broken-model", name: "Broken Model", provider: "broken" }],
    stream() {
      const stream = new EventStream<StreamEvent, AssistantMessage>({
        isTerminal: (event) => event.type === "done" || event.type === "error",
        getResult: (event) => {
          if (event.type === "done" || event.type === "error") return event.message;
          throw new Error("terminal expected");
        },
      });
      queueMicrotask(() => stream.fail(new Error("provider blew up")));
      return stream;
    },
  };

  const stream = runAgentLoop("hello", { provider });
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  const result = await stream.result();

  assert.equal(events.at(-1)?.type, "agent_end");
  assert.equal(result.assistant.stopReason, "error");
  assert.equal(result.assistant.errorMessage, "provider blew up");
});

test("cancellation returns an aborted assistant message", async () => {
  const controller = new AbortController();
  controller.abort();
  const handle = createFauxProvider({ responses: ["never"] });

  const stream = runAgentLoop("hello", { provider: handle.provider, signal: controller.signal });
  for await (const _ of stream) {
    // drain
  }
  const result = await stream.result();

  assert.equal(result.assistant.stopReason, "aborted");
  assert.equal(result.assistant.errorMessage, "Operation aborted");
});

test("Agent commits messages only after a completed turn and returns defensive copies", async () => {
  const handle = createFauxProvider({ responses: ["done"] });
  const agent = new Agent({ provider: handle.provider });
  const snapshots: number[] = [];

  agent.subscribe(() => {
    snapshots.push(agent.snapshot().messages.length);
  });

  const assistant = await agent.prompt("hello");
  const snapshot = agent.snapshot();
  snapshot.messages.push({ role: "user", content: "mutate external copy" });

  assert.deepEqual(snapshots.every((count) => count === 0), true);
  assert.deepEqual(assistant.content, [{ type: "text", text: "done" }]);
  assert.equal(agent.snapshot().messages.length, 2);
});

test("Agent awaits listeners sequentially and recovers from listener failure", async () => {
  const handle = createFauxProvider({ responses: ["done", "again"] });
  const agent = new Agent({ provider: handle.provider });
  const order: string[] = [];
  let fail = true;

  agent.subscribe(async () => {
    order.push("first:start");
    await Promise.resolve();
    order.push("first:end");
    if (fail) throw new Error("listener failed");
  });
  agent.subscribe(() => {
    order.push("second");
  });

  await assert.rejects(agent.prompt("hello"), /listener failed/);
  assert.equal(agent.snapshot().isStreaming, false);

  fail = false;
  await agent.prompt("again");

  assert.deepEqual(order.slice(0, 2), ["first:start", "first:end"]);
  assert.equal(agent.snapshot().isStreaming, false);
});

test("Agent rejects concurrent prompts immediately", async () => {
  const handle = createFauxProvider({ responses: ["slow", "second"], chunkDelayMs: 5, chunkSize: 1 });
  const agent = new Agent({ provider: handle.provider });

  const first = agent.prompt("first");
  await assert.rejects(agent.prompt("second"), /already streaming/);
  await first;
});
