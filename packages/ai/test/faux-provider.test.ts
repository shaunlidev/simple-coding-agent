import assert from "node:assert/strict";
import test from "node:test";
import { createFauxProvider } from "../src/faux-provider.ts";
import type { AssistantMessage, ProviderContext, StreamEvent } from "../src/types.ts";

const emptyContext: ProviderContext = { messages: [] };

async function collect(handle: ReturnType<typeof createFauxProvider>, signal?: AbortSignal) {
  const stream = handle.provider.stream(handle.model, emptyContext, { signal });
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return {
    events,
    message: await stream.result(),
  };
}

test("string shorthand creates one text assistant response", async () => {
  const handle = createFauxProvider({ responses: ["hello"], chunkSize: 2 });

  const { events, message } = await collect(handle);

  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "text_start",
    "text_delta",
    "text_delta",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.deepEqual(message, {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "hello" }],
    provider: "faux",
    model: "faux-model",
    timestamp: message.timestamp,
    usage: { input: 0, output: 0, totalTokens: 0 },
  } satisfies AssistantMessage);
});

test("injected now and usage are deterministic", async () => {
  const handle = createFauxProvider({ responses: ["hello"], now: () => 12345 });

  const { message } = await collect(handle);

  assert.equal(message.timestamp, 12345);
  assert.deepEqual(message.usage, { input: 0, output: 0, totalTokens: 0 });
});

test("streams thinking and tool calls as legal events", async () => {
  const handle = createFauxProvider({
    chunkSize: 5,
    responses: [
      {
        type: "success",
        content: [
          { type: "thinking", thinking: "inspect files" },
          {
            type: "tool_call",
            id: "call-1",
            name: "read",
            arguments: { path: "README.md", limit: 20 },
          },
        ],
      },
    ],
  });

  const { events, message } = await collect(handle);

  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_delta",
    "thinking_delta",
    "thinking_end",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_end",
    "done",
  ]);
  assert.equal(message.stopReason, "tool_call");
  assert.deepEqual(message.content.at(-1), {
    type: "tool_call",
    id: "call-1",
    name: "read",
    arguments: { path: "README.md", limit: 20 },
  });
});

test("response queue is consumed FIFO", async () => {
  const handle = createFauxProvider({ responses: ["first", "second"], chunkSize: 10 });

  assert.equal(handle.pendingResponses(), 2);
  assert.deepEqual((await collect(handle)).message.content, [{ type: "text", text: "first" }]);
  assert.equal(handle.pendingResponses(), 1);
  assert.deepEqual((await collect(handle)).message.content, [{ type: "text", text: "second" }]);
  assert.equal(handle.pendingResponses(), 0);
});

test("queue exhaustion returns a protocol-level error", async () => {
  const handle = createFauxProvider({ responses: [] });

  const { events, message } = await collect(handle);

  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Faux provider response queue is exhausted");
  assert.deepEqual(message.content, []);
});

test("failure responses emit protocol-level error messages", async () => {
  const handle = createFauxProvider({
    responses: [{ type: "failure", errorMessage: "provider unavailable" }],
  });

  const { events, message } = await collect(handle);

  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "provider unavailable");
});

test("fixed chunk size produces deterministic deltas", async () => {
  const handle = createFauxProvider({ responses: ["abcdef"], chunkSize: 2 });

  const { events } = await collect(handle);

  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ["ab", "cd", "ef"],
  );
});

test("abort before first chunk returns an aborted assistant error", async () => {
  const controller = new AbortController();
  controller.abort();
  const handle = createFauxProvider({ responses: ["abcdef"], chunkSize: 2 });

  const { events, message } = await collect(handle, controller.signal);

  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Aborted");
  assert.deepEqual(message.content, []);
});

test("abort mid-text preserves only emitted partial text", async () => {
  const controller = new AbortController();
  const handle = createFauxProvider({ responses: ["abcdef"], chunkSize: 2, chunkDelayMs: 1 });
  const stream = handle.provider.stream(handle.model, emptyContext, { signal: controller.signal });
  const iterator = stream[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value.type, "start");
  assert.equal((await iterator.next()).value.type, "text_start");
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", contentIndex: 0, delta: "ab" },
  });

  controller.abort();
  const errorEvent = await iterator.next();

  assert.equal(errorEvent.done, false);
  assert.equal(errorEvent.value.type, "error");
  assert.deepEqual(errorEvent.value.message.content, [{ type: "text", text: "ab" }]);
  assert.equal(errorEvent.value.message.errorMessage, "Aborted");
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("abort mid-tool-call never commits incomplete tool args", async () => {
  const controller = new AbortController();
  const handle = createFauxProvider({
    chunkSize: 5,
    chunkDelayMs: 1,
    responses: [
      {
        type: "success",
        content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "README.md" } }],
      },
    ],
  });
  const stream = handle.provider.stream(handle.model, emptyContext, { signal: controller.signal });
  const iterator = stream[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value.type, "start");
  assert.equal((await iterator.next()).value.type, "tool_call_start");
  assert.equal((await iterator.next()).value.type, "tool_call_delta");

  controller.abort();
  const errorEvent = await iterator.next();

  assert.equal(errorEvent.done, false);
  assert.equal(errorEvent.value.type, "error");
  assert.deepEqual(errorEvent.value.message.content, []);
  assert.equal(errorEvent.value.message.errorMessage, "Aborted");
});
