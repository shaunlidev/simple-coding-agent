import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeekProvider } from "../src/deepseek-provider.ts";
import type { Provider } from "../src/types.ts";

const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 };
const choice = { finish_reason: "stop", message: { content: "actual response" } };
const sse = (chunks: unknown[], done = true) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""));

async function collect(provider: Provider) {
  const stream = provider.stream(provider.models[0], { messages: [{ role: "user", content: "Return JSON" }] });
  const result = stream.result().catch((error: unknown) => error);
  const events = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    await result;
    throw error;
  }
  const message = await result;
  if (message instanceof Error) throw message;
  return { events, message: await stream.result() };
}

test("non-stream usage and response model metadata are preserved, missing usage stays unknown", async () => {
  const { message } = await collect(createDeepSeekProvider({ apiKey: "fixture", fetch: async () => Response.json({ model: "actual-model", choices: [choice], usage }) }));
  assert.deepEqual(message.usage, { input: 100, output: 20, totalTokens: 120, cacheReadInput: 30, cacheWriteInput: 70 });
  assert.equal(message.model, "actual-model");
  assert.equal(message.provider, "deepseek");
  const absent = await collect(createDeepSeekProvider({ apiKey: "fixture", fetch: async () => Response.json({ choices: [choice] }) }));
  assert.equal(absent.message.usage, undefined);
});

test("streamed usage works on final choice or usage-only chunk and explicit request limits are sent", async () => {
  for (const usageOnly of [false, true]) {
    let request: unknown;
    const provider = createDeepSeekProvider({
      apiKey: "fixture", stream: true, maxOutputTokens: 123, responseFormat: "json_object",
      fetch: async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return sse([
          { choices: [{ delta: { content: "{}" }, finish_reason: "stop" }], ...(usageOnly ? {} : { usage }) },
          ...(usageOnly ? [{ choices: [], usage }] : []),
        ]);
      },
    });
    const { message } = await collect(provider);
    assert.equal(message.usage?.totalTokens, 120);
    assert.equal(typeof request, "object");
    assert.ok(request && typeof request === "object" && "max_tokens" in request && "stream_options" in request && "response_format" in request);
    assert.equal(request.max_tokens, 123);
    assert.deepEqual(request.stream_options, { include_usage: true });
    assert.deepEqual(request.response_format, { type: "json_object" });
  }
});

test("abnormal finish reasons never report done and retain billed usage", async () => {
  for (const reason of ["length", "content_filter", "insufficient_system_resource", "aborted", "unexpected"]) {
    for (const stream of [false, true]) {
      const { message, events } = await collect(createDeepSeekProvider({
        apiKey: "fixture", stream,
        fetch: async () => stream
          ? sse([{ choices: [{ delta: { content: "partial" }, finish_reason: reason }], usage }])
          : Response.json({ choices: [{ ...choice, finish_reason: reason }], usage }),
      }));
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage ?? "", new RegExp(reason));
      assert.equal(message.usage?.totalTokens, 120);
      assert.equal(events.some((event) => event.type === "done"), false);
    }
  }
});

test("truncated streams fail without a terminal finish reason or DONE marker", async () => {
  for (const body of [sse([{ choices: [{ delta: { content: "partial" } }] }]), sse([{ choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] }], false)]) {
    const { message, events } = await collect(createDeepSeekProvider({ apiKey: "fixture", stream: true, fetch: async () => body }));
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /incomplete|truncated/i);
    assert.equal(events.some((event) => event.type === "done"), false);
  }
});

test("malformed usage is rejected rather than becoming false metrics", async () => {
  await assert.rejects(collect(createDeepSeekProvider({ apiKey: "fixture", fetch: async () => Response.json({ choices: [choice], usage: { ...usage, total_tokens: -1 } }) })), /usage|total_tokens/);
});

test("output truncation during tool JSON preserves usage without emitting an executable tool", async () => {
  const { message, events } = await collect(createDeepSeekProvider({ apiKey: "fixture", stream: true, fetch: async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "collect_source", arguments: '{"sourceId":' } }] }, finish_reason: "length" }], usage },
  ]) }));
  assert.equal(message.stopReason, "error");
  assert.equal(message.usage?.totalTokens, 120);
  assert.equal(events.some((event) => event.type === "tool_call_end"), false);
});

test("HTTP errors are classified without echoing untrusted provider bodies", async () => {
  for (const status of [400, 401, 429, 503]) {
    await assert.rejects(collect(createDeepSeekProvider({ apiKey: "fixture", fetch: async () => new Response("synthetic-private-upstream-value", { status }) })), (error: unknown) => {
      assert.ok(error instanceof Error && "status" in error && "retryable" in error);
      assert.equal(error.status, status);
      assert.equal(error.retryable, status === 429 || status === 503);
      assert.equal(error.message.includes("synthetic-private-upstream-value"), false);
      return true;
    });
  }
});

test("response byte caps cancel the body instead of accumulating unbounded output", { timeout: 1000 }, async () => {
  let cancelled = false;
  const provider = createDeepSeekProvider({ apiKey: "fixture", stream: true, maxResponseBytes: 64, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(65))); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(collect(provider), /response.*limit/i);
  assert.equal(cancelled, true);
});
