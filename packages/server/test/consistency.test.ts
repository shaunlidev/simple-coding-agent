import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthenticatedServer } from "./auth-fixture.ts";

test("R3.3 API retries with the same idempotency key return one logical run", async () => {
  const { app, database, request, runtime } = await createAuthenticatedServer();
  try {
    const call = () => request({ method: "POST", url: "/api/runs/run-now", headers: { "idempotency-key": "repeat-this-request" }, payload: {} });
    const first = await call();
    const second = await call();
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().runId, first.json().runId);
    assert.equal((await runtime.listEvents()).filter((event) => event.type === "run.started").length, 1);
    assert.equal((await runtime.listEvents()).filter((event) => event.type === "delivery.created").length, 1);
  } finally { await app.close(); database.sqlite.close(); }
});

test("R3.3 concurrent and post-restart retries preserve a single receipt; changed target conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-r3-api-"));
  const env = { AGENT_DB_PATH: join(directory, "state.sqlite") };
  let server = await createAuthenticatedServer({ env });
  const options = { method: "POST", url: "/api/runs/run-now", headers: { "idempotency-key": "durable-request" }, payload: {} } as const;
  try {
    const responses = await Promise.all([server.request(options), server.request(options), server.request(options)]);
    assert.equal(responses.every((response) => response.statusCode === 200), true);
    const runId: string = responses[0].json().runId;
    assert.equal(new Set(responses.map((response) => response.json().runId)).size, 1);
    const result = server.runtime.readRunResult(runId);
    assert.ok(result);
    assert.equal((await server.runtime.listEvents(runId)).filter((event) => event.type === "run.started").length, 1);
    await server.app.close();
    server.database.sqlite.close();
    server = await createAuthenticatedServer({ env });
    const retried = await server.request(options);
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().runId, runId);
    assert.deepEqual(server.runtime.readRunResult(runId), result);
    await server.runtime.createSchedule({ id: "different-task", title: "Different task", cron: "@every 1h", timezone: "UTC", enabled: true, nextRunAt: new Date().toISOString(), overlapPolicy: "skip" });
    assert.equal((await server.request({ ...options, url: "/api/schedules/different-task/run-now" })).statusCode, 409);
    assert.equal((await server.runtime.listRuns()).length, 1);
  } finally { await server.app.close(); server.database.sqlite.close(); await rm(directory, { recursive: true, force: true }); }
});

test("R3 readiness and snapshot do not start background demo work", async () => {
  const { app, database, request, runtime } = await createAuthenticatedServer();
  try {
    assert.equal((await request({ url: "/readyz" })).statusCode, 503);
    assert.equal((await request({ url: "/api/snapshot" })).statusCode, 200);
    assert.deepEqual(await runtime.listRuns(), []);
    assert.deepEqual(await runtime.readSchedules(), []);
  } finally { await app.close(); database.sqlite.close(); }
});
