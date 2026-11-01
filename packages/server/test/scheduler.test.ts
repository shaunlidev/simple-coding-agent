import test from "node:test";
import assert from "node:assert/strict";
import { createDeepSeekProvider } from "@simple-coding-agent/ai";
import { SafeNetwork } from "@simple-coding-agent/security";
import { createAuthenticatedServer } from "./auth-fixture.ts";

const definition = { id: "cancel-task", title: "Cancellation", instruction: "Read the source", model: "fixture", sources: [{ id: "source", kind: "url", url: "https://source.test/page" }] };
function latch() { let release = () => {}; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("R5.1 schedule API rejects invalid clocks and client-written runtime timestamps", async () => {
  const server = await createAuthenticatedServer();
  try {
    for (const patch of [{ cron: "garbage" }, { cron: "@every 0s" }, { timezone: "Not/AZone" }, { nextRunAt: "bad" }, { lastRunAt: "2026-01-01T00:00:00Z" }]) {
      const response = await server.request({ method: "POST", url: "/api/schedules", payload: { id: "invalid", title: "Invalid", cron: "0 9 * * *", timezone: "UTC", ...patch } });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.deepEqual(server.runtime.readSchedulesSync(), []);
    assert.equal((await server.request({ method: "POST", url: "/api/scheduler/tick", payload: { now: "2099-01-01T00:00:00Z" } })).statusCode, 400);
  } finally { await server.app.close(); server.database.sqlite.close(); }
});

for (const phase of ["provider", "url", "rss"] as const) {
  test(`R5.2 API cancellation reaches actual ${phase} AbortSignal; no subsequent calls or delivery`, { timeout: 5000 }, async () => {
    const entered = latch(); let aborted = false; let calls = 0;
    const block = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.throwIfAborted(); entered.release();
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    });
    const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ signal }) => block(signal) });
    const server = await createAuthenticatedServer({ env: { AGENT_DEMO_MODE: "0" }, network, providerFactory: () => createDeepSeekProvider({ apiKey: "synthetic", fetch: async (_url, init) => {
      calls++;
      if (phase === "provider") { assert.ok(init?.signal); return block(init.signal); }
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "collect", type: "function", function: { name: "collect_source", arguments: '{"sourceId":"source"}' } }] } }] });
    } }) });
    try {
      server.runtime.saveContentTask({ ...definition, sources: [{ ...definition.sources[0], kind: phase === "rss" ? "rss" : "url" }] }, 0);
      const response = await server.request({ method: "POST", url: "/api/runs/run-now", payload: { taskId: definition.id } });
      assert.equal(response.statusCode, 200, response.body);
      const runId = response.json().runId;
      await entered.promise;
      const cancel = await server.request({ method: "POST", url: `/api/runs/${runId}/cancel`, payload: {} });
      assert.equal(cancel.statusCode, 200);
      await server.scheduler.idle();
      assert.equal(aborted, true);
      assert.equal(calls, 1);
      assert.equal(server.runtime.readRunDetail(runId)?.run.status, "cancelled");
      assert.equal(server.runtime.readRunResult(runId), undefined);
      assert.equal(server.runtime.readSourceResults(runId).length, 0);
      assert.equal((await server.request({ method: "POST", url: `/api/runs/${runId}/cancel`, payload: {} })).json().status, "cancelled");
    } finally { await server.app.close(); server.database.sqlite.close(); }
  });
}
