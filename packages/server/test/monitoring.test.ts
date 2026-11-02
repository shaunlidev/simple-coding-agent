import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createSqliteDatabase } from "@simple-coding-agent/db";
import { parseEnvironment } from "@simple-coding-agent/security";
import { authEnv, createAuthenticatedServer, operatorSecret, viewerSecret } from "./auth-fixture.ts";

test("R7 environment validates heartbeat and monitor deadlines", () => {
  assert.equal(parseEnvironment({}).AGENT_HEARTBEAT_MS, 30_000);
  for (const env of [{ AGENT_HEARTBEAT_MS: "90000" }, { AGENT_MONITOR_OVERDUE_MS: "5000" }, { AGENT_MONITOR_POLL_MS: "NaN" }, { AGENT_HEARTBEAT_STALE_MS: "-1" }]) assert.throws(() => parseEnvironment(env));
});

test("R7 readiness follows worker health; health and monitoring GETs do not renew it", async () => {
  let now = Date.parse("2026-11-02T00:00:00Z"); let mono = 0;
  const timers = new Map<string, () => void>();
  const server = await createAuthenticatedServer({ startScheduler: true, monitoring: {
    now: () => new Date(now), monotonic: () => mono,
    policy: { heartbeatMs: 30, staleMs: 90, pollMs: 5, overdueMs: 15 },
    repeat: (kind, callback) => { timers.set(kind, callback); return () => { timers.delete(kind); }; },
  } });
  try {
    const ready = await server.app.inject("/readyz");
    assert.equal(ready.statusCode, 200);
    assert.equal("session" in ready.json().worker, false);
    assert.equal("activeRunId" in ready.json().worker, false);
    assert.equal((await server.app.inject("/api/monitoring")).statusCode, 401);
    const before = server.database.sqlite.prepare("select * from worker_monitor_state order by id").all();
    for (let i = 0; i < 5; i++) {
      assert.equal((await server.request({ url: "/api/monitoring" })).json().health.ready, true);
      assert.equal((await server.app.inject("/readyz")).statusCode, 200);
    }
    assert.deepEqual(server.database.sqlite.prepare("select * from worker_monitor_state order by id").all(), before);
    for (let i = 0; i < 18; i++) { now += 5; mono += 5; timers.get("monitor")?.(); }
    const stale = await server.app.inject("/readyz");
    assert.equal(stale.statusCode, 503); assert.equal(stale.json().worker.heartbeat, "stale");
    assert.equal((await server.app.inject("/healthz")).statusCode, 200);
    timers.get("heartbeat")?.(); timers.get("monitor")?.();
    const recovered = (await server.request({ url: "/api/monitoring" })).json();
    assert.equal(recovered.health.worker.heartbeat, "fresh");
    assert.equal(recovered.health.ready, false);
    assert.equal(recovered.alerts.filter((a: { condition: string }) => a.condition === "heartbeat_stale").length, 2);
    const first = (await server.request({ url: "/api/monitoring/alerts?limit=1" })).json().alerts[0];
    const rest = (await server.request({ url: `/api/monitoring/alerts?after=${first.sequence}` })).json().alerts;
    assert.ok(rest.every((a: { sequence: number }) => a.sequence > first.sequence));
    assert.equal((await server.request({ url: "/api/monitoring/alerts?limit=501" })).statusCode, 400);
    assert.equal((await server.runtime.listRuns()).length, 0);
    server.database.sqlite.close();
    assert.equal((await server.app.inject("/readyz")).statusCode, 503);
    assert.equal((await server.app.inject("/healthz")).statusCode, 200);
  } finally { await server.app.close(); if (server.database.sqlite.open) server.database.sqlite.close(); }
});

test("R7 output pruning requires operator, CSRF and matching consumed approval", async () => {
  const server = await createAuthenticatedServer();
  try {
    const runId = "prune-test"; const timestamp = "2026-10-01T00:00:00.000Z";
    for (const event of [
      server.runtime.createEvent(runId, "run.started", { title: "Prune test", trigger: "manual" }),
      server.runtime.createEvent(runId, "agent.output.delta", { turn: 1, delta: "Disposable" }),
      server.runtime.createEvent(runId, "run.failed", { reason: "fixture" }),
    ]) server.runtime.appendEventSync({ ...event, timestamp });
    const operation = { runId, tool: "telemetry_prune", args: { key: "prune-request", before: "2026-10-02T00:00:00Z", maxRows: 1 } };
    assert.equal((await server.request({ method: "POST", url: "/api/tools/execute", payload: operation })).statusCode, 403);
    assert.equal((await server.request({ method: "POST", url: "/api/security/approvals", payload: operation, headers: { "x-csrf-token": "invalid" } })).statusCode, 403);
    const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "guest", secret: viewerSecret } });
    const viewerHeaders = { cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
    assert.equal((await server.app.inject({ method: "POST", url: "/api/security/approvals", payload: operation, headers: viewerHeaders })).statusCode, 403);
    assert.equal(server.database.sqlite.prepare("select 1 from runtime_events where type='agent.output.delta'").all().length, 1);
    const approval = await server.request({ method: "POST", url: "/api/security/approvals", payload: operation });
    assert.equal(approval.statusCode, 200);
    const approvalId = approval.json().id;
    assert.equal((await server.request({ method: "POST", url: `/api/security/approvals/${approvalId}/approve`, payload: {} })).statusCode, 200);
    const response = await server.request({ method: "POST", url: "/api/tools/execute", payload: { ...operation, approvalId } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().deleted, 1);
    assert.equal(server.database.sqlite.prepare("select 1 from runtime_events where type='agent.output.delta'").all().length, 0);
    assert.equal(server.database.sqlite.prepare("select 1 from runtime_prunes").all().length, 1);
    assert.equal((await server.request({ method: "POST", url: "/api/tools/execute", payload: { ...operation, approvalId } })).statusCode, 403);
    assert.equal(server.runtime.readRunDetail(runId)?.run.status, "failed");
  } finally { await server.app.close(); server.database.sqlite.close(); }
});

test("R7 graceful shutdown ends an actual open SSE response before closing the worker", { timeout: 5000 }, async () => {
  const server = await createAuthenticatedServer({ startScheduler: true });
  const controller = new AbortController(); let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const origin = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: operatorSecret } });
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const stream = await fetch(`${origin}/api/events/stream`, { headers: { cookie }, signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader(); assert.equal((await reader.read()).done, false);
    await Promise.race([server.app.close(), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Open SSE prevented shutdown")), 2000); })]);
    assert.equal(server.monitoring.read().worker.phase, "stopped");
    while (!(await reader.read()).done) { /* Drain already-buffered SSE bytes. */ }
  } finally { clearTimeout(deadline); controller.abort(); await server.app.close(); server.database.sqlite.close(); }
});

test("R7 executable listen failure drains monitoring and exits without a live worker", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-r7-listen-"));
  const path = join(directory, "runtime.sqlite"); const occupied = createServer();
  try {
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address(); assert.ok(address && typeof address !== "string");
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../dist/entry.js", import.meta.url)), "--port", String(address.port)], {
      timeout: 5000,
      env: { ...process.env, ...authEnv, NODE_ENV: "test", AGENT_DB_PATH: path, AGENT_SERVER_HOST: "127.0.0.1", DEEPSEEK_API_KEY: "", AGENT_REQUIRE_PRODUCTION_SECRETS: "0" },
    }), (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && "code" in error);
      assert.equal(error.code, 1); assert.match(String(error.stderr), /EADDRINUSE/); assert.equal(String(error.stderr).includes(operatorSecret), false);
      return true;
    });
    const database = createSqliteDatabase(path);
    try {
      const row = database.sqlite.prepare("select payload_json from worker_monitor_state where id='worker'").get() as { payload_json: string };
      assert.equal(JSON.parse(row.payload_json).phase, "stopped");
    } finally { database.sqlite.close(); }
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
