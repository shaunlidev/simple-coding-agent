import assert from "node:assert/strict";
import test from "node:test";
import { EventStream } from "../src/event-stream.ts";
import type { AssistantMessage, StreamEvent } from "../src/types.ts";
import { createStreamEventValidator, StreamSequenceError } from "../src/validation.ts";

const doneTextMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello world" }],
  stopReason: "stop",
};

const validTrace: StreamEvent[] = [
  { type: "start" },
  { type: "text_start", contentIndex: 0 },
  { type: "text_delta", contentIndex: 0, delta: "hello " },
  { type: "text_delta", contentIndex: 0, delta: "world" },
  { type: "text_end", contentIndex: 0, content: "hello world" },
  { type: "done", reason: "stop", message: doneTextMessage },
];

function acceptTrace(trace: StreamEvent[]): void {
  const validator = createStreamEventValidator();
  for (const event of trace) {
    validator.accept(event);
  }
}

test("accepts a complete text stream", () => {
  acceptTrace(validTrace);
});

test("accepts thinking followed by a tool call", () => {
  acceptTrace([
    { type: "start" },
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "inspect" },
    { type: "thinking_end", contentIndex: 0, content: "inspect" },
    { type: "tool_call_start", contentIndex: 1, id: "call-1", name: "read" },
    { type: "tool_call_delta", contentIndex: 1, argumentsDelta: '{"path":' },
    { type: "tool_call_delta", contentIndex: 1, argumentsDelta: '"README.md"}' },
    {
      type: "tool_call_end",
      contentIndex: 1,
      toolCall: {
        type: "tool_call",
        id: "call-1",
        name: "read",
        arguments: { path: "README.md" },
      },
    },
    {
      type: "done",
      reason: "tool_call",
      message: {
        role: "assistant",
        stopReason: "tool_call",
        content: [
          { type: "thinking", thinking: "inspect" },
          {
            type: "tool_call",
            id: "call-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
      },
    },
  ]);
});

test("accepts error with safe partial text content", () => {
  acceptTrace([
    { type: "start" },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "partial" },
    {
      type: "error",
      reason: "error",
      message: {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "partial" }],
      },
    },
  ]);
});

test("rejects common invalid stream mutations", () => {
  const cases: Array<{ name: string; trace: StreamEvent[]; message: RegExp }> = [
    {
      name: "delta before start",
      trace: [{ type: "text_delta", contentIndex: 0, delta: "hello" }],
      message: /expected "start"/,
    },
    {
      name: "text delta without active text block",
      trace: [{ type: "start" }, { type: "text_delta", contentIndex: 0, delta: "hello" }],
      message: /expected active text block/,
    },
    {
      name: "skipped content index",
      trace: [{ type: "start" }, { type: "text_start", contentIndex: 1 }],
      message: /expected contentIndex 0, received 1/,
    },
    {
      name: "block starts while another block is active",
      trace: [
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "thinking_start", contentIndex: 0 },
      ],
      message: /cannot start a new block while text is active/,
    },
    {
      name: "end content differs from accumulated deltas",
      trace: [
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "hello" },
        { type: "text_end", contentIndex: 0, content: "goodbye" },
      ],
      message: /end content does not match accumulated deltas/,
    },
    {
      name: "tool delta without active tool block",
      trace: [{ type: "start" }, { type: "tool_call_delta", contentIndex: 0, argumentsDelta: "{}" }],
      message: /expected active tool_call block/,
    },
    {
      name: "invalid accumulated tool JSON",
      trace: [
        { type: "start" },
        { type: "tool_call_start", contentIndex: 0, id: "call-1", name: "read" },
        { type: "tool_call_delta", contentIndex: 0, argumentsDelta: '{"path":' },
        {
          type: "tool_call_end",
          contentIndex: 0,
          toolCall: {
            type: "tool_call",
            id: "call-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        },
      ],
      message: /tool arguments must be valid JSON/,
    },
    {
      name: "tool end identity changed",
      trace: [
        { type: "start" },
        { type: "tool_call_start", contentIndex: 0, id: "call-1", name: "read" },
        {
          type: "tool_call_end",
          contentIndex: 0,
          toolCall: {
            type: "tool_call",
            id: "call-2",
            name: "read",
            arguments: {},
          },
        },
      ],
      message: /tool id must remain "call-1"/,
    },
    {
      name: "tool end arguments differ from accumulated JSON",
      trace: [
        { type: "start" },
        { type: "tool_call_start", contentIndex: 0, id: "call-1", name: "read" },
        { type: "tool_call_delta", contentIndex: 0, argumentsDelta: '{"path":"README.md"}' },
        {
          type: "tool_call_end",
          contentIndex: 0,
          toolCall: {
            type: "tool_call",
            id: "call-1",
            name: "read",
            arguments: { path: "package.json" },
          },
        },
      ],
      message: /final tool arguments must match accumulated arguments/,
    },
    {
      name: "done while block is active",
      trace: [
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "done", reason: "stop", message: { role: "assistant", stopReason: "stop", content: [] } },
      ],
      message: /done cannot terminate an active block/,
    },
    {
      name: "done message does not match completed content",
      trace: [
        { type: "start" },
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "hello" },
        { type: "text_end", contentIndex: 0, content: "hello" },
        { type: "done", reason: "stop", message: { role: "assistant", stopReason: "stop", content: [] } },
      ],
      message: /done message content must match completed stream content/,
    },
    {
      name: "event after terminal",
      trace: [...validTrace, { type: "text_start", contentIndex: 1 }],
      message: /no events are allowed after a terminal event/,
    },
  ];

  for (const invalid of cases) {
    assert.throws(() => acceptTrace(invalid.trace), invalid.message, invalid.name);
  }
});

test("invalid events do not mutate validator state", () => {
  const validator = createStreamEventValidator();
  validator.accept({ type: "start" });
  validator.accept({ type: "text_start", contentIndex: 0 });
  validator.accept({ type: "text_delta", contentIndex: 0, delta: "hello" });

  assert.throws(() => {
    validator.accept({ type: "text_end", contentIndex: 0, content: "HELLO" });
  }, /end content does not match accumulated deltas/);

  validator.accept({ type: "text_end", contentIndex: 0, content: "hello" });
  validator.accept({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "hello" }],
    },
  });
});

test("assistant message event stream validates before yielding events", async () => {
  const validator = createStreamEventValidator();
  const stream = new EventStream<StreamEvent, AssistantMessage>({
    validate: (event) => validator.accept(event),
    isTerminal: (event) => event.type === "done" || event.type === "error",
    getResult: (event) => {
      if (event.type === "done" || event.type === "error") return event.message;
      throw new Error("Expected terminal stream event");
    },
  });
  stream.push({ type: "start" });
  stream.push({ type: "text_start", contentIndex: 0 });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "hello world" });
  stream.push({ type: "text_end", contentIndex: 0, content: "hello world" });
  stream.push({ type: "done", reason: "stop", message: doneTextMessage });

  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.deepEqual(await stream.result(), doneTextMessage);
});

test("assistant message event stream fails result on invalid provider sequence", async () => {
  const validator = createStreamEventValidator();
  const stream = new EventStream<StreamEvent, AssistantMessage>({
    validate: (event) => validator.accept(event),
    isTerminal: (event) => event.type === "done" || event.type === "error",
    getResult: (event) => {
      if (event.type === "done" || event.type === "error") return event.message;
      throw new Error("Expected terminal stream event");
    },
  });
  stream.push({ type: "start" });

  assert.throws(() => {
    stream.push({ type: "text_delta", contentIndex: 0, delta: "orphan" });
  }, (error) => error instanceof StreamSequenceError);

  await assert.rejects(stream.result(), (error) => error instanceof StreamSequenceError);
});
