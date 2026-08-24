import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeekProvider } from "../src/deepseek-provider.ts";
import type { ProviderContext } from "../src/types.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: readonly unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function collect(provider = createDeepSeekProvider({ apiKey: "test-key", fetch: async () => jsonResponse({
  choices: [{ finish_reason: "stop", message: { content: "hello" } }],
}) })) {
  const stream = provider.stream(provider.models[0], { messages: [{ role: "user", content: "hello" }] });
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, message: await stream.result() };
}

test("missing API key produces a clear configuration error", async () => {
  const provider = createDeepSeekProvider({
    apiKey: "",
    fetch: async () => jsonResponse({ choices: [] }),
  });
  const stream = provider.stream(provider.models[0], { messages: [{ role: "user", content: "hello" }] });
  const drain = (async () => {
    for await (const _ of stream) {
      // drain until failure
    }
  })();
  const result = stream.result();

  await assert.rejects(drain, /DEEPSEEK_API_KEY is required/);
  await assert.rejects(result, /DEEPSEEK_API_KEY is required/);
});

test("non-stream response emits text assistant message", async () => {
  const { events, message } = await collect();

  assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
  assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
});

test("non-stream response emits tool call assistant message", async () => {
  const provider = createDeepSeekProvider({
    apiKey: "test-key",
    fetch: async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"README.md"}' },
                },
              ],
            },
          },
        ],
      }),
  });

  const { message } = await collect(provider);

  assert.equal(message.stopReason, "tool_call");
  assert.deepEqual(message.content, [
    { type: "tool_call", id: "call-1", name: "read", arguments: { path: "README.md" } },
  ]);
});

test("request body uses OpenAI-compatible DeepSeek chat format", async () => {
  let requestBody: unknown;
  const provider = createDeepSeekProvider({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    },
  });
  const context: ProviderContext = {
    systemPrompt: "system",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        stopReason: "tool_call",
        content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "README.md" } }],
      },
      { role: "tool", toolCallId: "call-1", toolName: "read", content: "contents" },
    ],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" } },
        },
      },
    ],
  };

  const stream = provider.stream(provider.models[0], context);
  for await (const _ of stream) {
    // drain
  }

  assert.deepEqual(requestBody, {
    model: "deepseek-v4-flash",
    stream: false,
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }],
      },
      { role: "tool", content: "contents", tool_call_id: "call-1" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: { path: { type: "string" } },
          },
        },
      },
    ],
  });
});

test("request body can require tool choice and enable thinking", async () => {
  let requestBody: unknown;
  const provider = createDeepSeekProvider({
    apiKey: "test-key",
    thinking: true,
    toolChoice: "required",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    },
  });

  const stream = provider.stream(provider.models[0], {
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      },
    ],
  });
  for await (const _ of stream) {
    // drain
  }

  assert.equal((requestBody as { tool_choice?: string; thinking?: unknown }).tool_choice, "required");
  assert.equal("thinking" in (requestBody as Record<string, unknown>), false);
});

test("streaming SSE chunks emit text and tool deltas", async () => {
  const provider = createDeepSeekProvider({
    apiKey: "test-key",
    stream: true,
    fetch: async () =>
      sseResponse([
        { choices: [{ delta: { content: "hi " } }] },
        { choices: [{ delta: { content: "there" }, finish_reason: "stop" }] },
      ]),
  });

  const { events, message } = await collect(provider);

  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ["hi ", "there"],
  );
  assert.deepEqual(message.content, [{ type: "text", text: "hi there" }]);
});

test("streaming SSE emits deltas before the response body is complete", async () => {
  const encoder = new TextEncoder();
  const secondChunk = deferred();
  let waitingForSecondChunk = false;
  const provider = createDeepSeekProvider({
    apiKey: "test-key",
    stream: true,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`));
          },
          async pull(controller) {
            if (waitingForSecondChunk) return;
            waitingForSecondChunk = true;
            await secondChunk.promise;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: "stop" }] })}\n\n`),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });

  const stream = provider.stream(provider.models[0], { messages: [{ role: "user", content: "hello" }] });
  const iterator = stream[Symbol.asyncIterator]();
  const seen = [];
  while (true) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    seen.push(next.value);
    if (next.value.type === "text_delta") break;
  }

  assert.equal(seen.some((event) => event.type === "text_delta" && event.delta === "hi"), true);
  assert.equal(waitingForSecondChunk, true);

  secondChunk.resolve();
  while (!(await iterator.next()).done) {
    // drain
  }
  assert.deepEqual((await stream.result()).content, [{ type: "text", text: "hi!" }]);
});
