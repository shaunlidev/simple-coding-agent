import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDeepSeekProvider } from "@simple-coding-agent/ai";
import { SafeNetwork } from "@simple-coding-agent/security";
import { createAuthenticatedServer } from "./auth-fixture.ts";

function network() {
  return new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => ({ url: url.href, status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("Actual release evidence from the configured source.") }) });
}
const definition = { id: "real-task", title: "Real research", instruction: "Summarize releases", sources: [{ id: "source", kind: "url", url: "https://source.test/page" }] };

async function completed(server: Awaited<ReturnType<typeof createAuthenticatedServer>>, runId: string) {
  for (let n = 0; n < 100; n++) {
    const detail = server.runtime.readRunDetail(runId);
    if (detail && ["completed", "failed", "cancelled"].includes(detail.run.status)) return detail;
    await delay(5);
  }
  throw new Error("Run did not terminate");
}

test("R4 real-mode API requires configuration and missing credentials never use demo", async () => {
  const server = await createAuthenticatedServer({ env: { AGENT_DEMO_MODE: "0", DEEPSEEK_API_KEY: "" }, network: network() });
  try {
    assert.equal((await server.request({ method: "POST", url: "/api/runs/run-now", payload: {} })).statusCode, 400);
    assert.deepEqual(await server.runtime.listRuns(), []);
    const saved = await server.request({ method: "PUT", url: "/api/tasks/real-task", payload: { definition, expectedRevision: 0 } });
    assert.equal(saved.statusCode, 200);
    const response = await server.request({ method: "POST", url: "/api/runs/run-now", payload: { taskId: "real-task" } });
    const detail = await completed(server, response.json().runId);
    assert.equal(detail.run.status, "failed");
    assert.ok(detail.events.some((event) => event.type === "run.failed" && String(event.payload.detail).includes("DEEPSEEK_API_KEY")));
    assert.equal(detail.result, null);
    assert.equal(detail.events.some((event) => event.payload.mode === "demo"), false);
  } finally { await server.app.close(); server.database.sqlite.close(); }
});

test("R4 manual and scheduled tasks use the same Agent executor and frozen task; retries do not repeat paid calls", async () => {
  let calls = 0;
  let now = new Date();
  const server = await createAuthenticatedServer({ env: { AGENT_DEMO_MODE: "0" }, now: () => now, network: network(), providerFactory: (task) => createDeepSeekProvider({
    apiKey: "fixture", model: task.model, maxOutputTokens: task.limits.maxOutputTokens,
    fetch: async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.max_tokens, task.limits.maxOutputTokens);
      const tool = request.messages.find((message: { role: string }) => message.role === "tool");
      if (!tool) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call", type: "function", function: { name: "collect_source", arguments: '{"sourceId":"source"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      const document = JSON.parse(tool.content).documents[0];
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ documentId: document.id, summary: "A real configured release source was read.", reason: "Matches the release request.", score: 80, quotes: [document.text] }] }) } }], usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 } });
    },
  }) });
  try {
    assert.equal((await server.request({ method: "PUT", url: "/api/tasks/real-task", payload: { definition, expectedRevision: 0 } })).statusCode, 200);
    const request = { method: "POST", url: "/api/runs/run-now", headers: { "idempotency-key": "once" }, payload: { taskId: "real-task" } } as const;
    const response = await server.request(request);
    const first = await completed(server, response.json().runId);
    assert.equal(first.run.trigger, "manual");
    assert.equal(first.run.status, "completed");
    assert.equal((await server.request(request)).json().runId, first.run.id);
    assert.equal(calls, 2);
    const trace = await server.request({ method: "GET", url: `/api/runs/${first.run.id}/trace` });
    assert.equal(trace.statusCode, 200);
    assert.equal(trace.json().spans.filter((span: { type: string }) => span.type === "llm").length, 2);
    assert.equal(trace.json().spans.filter((span: { type: string }) => span.type === "tool").length, 1);
    assert.equal(trace.json().spans.find((span: { type: string }) => span.type === "root").costUsd, null);
    assert.equal(JSON.stringify(trace.json()).includes("Actual release evidence from the configured source."), false);
    assert.equal((await server.app.inject({ method: "GET", url: `/api/runs/${first.run.id}/trace` })).statusCode, 401);
    assert.equal((await server.request({ method: "GET", url: "/api/runs/not-present/trace" })).statusCode, 404);
    assert.equal((await server.request({ method: "POST", url: "/api/schedules", payload: { id: "schedule", taskId: "real-task", title: "Scheduled research", cron: "@every 1h", timezone: "UTC" } })).statusCode, 200);
    now = new Date(now.getTime() + 3_600_000);
    const tick = await server.request({ method: "POST", url: "/api/scheduler/tick", payload: {} });
    const scheduled = await completed(server, tick.json().results[0].runId);
    assert.equal(scheduled.run.trigger, "schedule");
    assert.equal(scheduled.run.status, "completed");
    assert.equal(scheduled.result?.outcome, "no_new_items");
    assert.equal(scheduled.task?.definition.id, "real-task");
    assert.equal(calls, 4);
  } finally { await server.app.close(); server.database.sqlite.close(); }
});
