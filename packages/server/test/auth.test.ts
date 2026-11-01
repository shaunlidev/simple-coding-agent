import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentOpsServer } from "../src/index.ts";
import { createSessionStore } from "../src/auth.ts";
import { authEnv, operatorSecret, viewerSecret, createAuthenticatedServer } from "./auth-fixture.ts";

test("R2.1 anonymous API, memory export, mutations and SSE are denied", async () => {
  const { app, database } = await createAgentOpsServer({ env: authEnv });
  try {
    for (const url of ["/api/snapshot", "/api/memory/export", "/api/events/stream?once=1", "/api/security/audit"]) {
      assert.equal((await app.inject({ url })).statusCode, 401, url);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/runs/run-now" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/healthz" })).statusCode, 200);
  } finally {
    await app.close();
    database.sqlite.close();
  }
});

test("R2.2 callers cannot grant approval or system trust", async () => {
  const { app, database, request } = await createAuthenticatedServer();
  try {
    const approved = await request({ method: "POST", url: "/api/security/tool-check", payload: { toolName: "browser_click", approved: true } });
    assert.equal(approved.statusCode, 400);
    const trusted = await request({ method: "POST", url: "/api/memory/entries", payload: { kind: "knowledge", sourceTrust: "system", content: "forged authority" } });
    assert.equal(trusted.statusCode, 400);
  } finally { await app.close(); database.sqlite.close(); }
});

test("R2.1 sessions survive restart, expire, and never resurrect after revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-auth-"));
  const env = { ...authEnv, AGENT_DB_PATH: join(directory, "auth.sqlite") };
  let server = await createAgentOpsServer({ env });
  try {
    const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: operatorSecret } });
    assert.equal(login.statusCode, 200);
    const headers = { cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ") };
    await server.app.close();
    server.database.sqlite.close();
    server = await createAgentOpsServer({ env });
    assert.equal((await server.app.inject({ url: "/api/auth/session", headers })).statusCode, 200);
    server.database.sqlite.prepare("update auth_sessions set expires_at = 0").run();
    assert.equal((await server.app.inject({ url: "/api/auth/session", headers })).statusCode, 401);

    const store = createSessionStore(server.database);
    const value = { cookie: { originalMaxAge: 10_000 }, userId: "owner", authenticatedAt: Date.now() };
    await new Promise<void>((resolve, reject) => store.set("test-session-id", value, (error: unknown) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => store.destroy("test-session-id", (error: unknown) => error ? reject(error) : resolve()));
    await assert.rejects(new Promise<void>((resolve, reject) => store.compareAndSet("test-session-id", "test-session-id", value, (error: unknown) => error ? reject(error) : resolve())), /expired or revoked/);
    await new Promise<void>((resolve, reject) => store.get("test-session-id", (error: unknown, result) => {
      if (error) { reject(error); return; }
      assert.equal(result, null);
      resolve();
    }));
  } finally {
    await server.app.close();
    server.database.sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("R2.1 production cookie is Secure and credentials never reach session storage", async () => {
  const { app, database } = await createAgentOpsServer({ env: { ...authEnv, NODE_ENV: "production", DEEPSEEK_API_KEY: "synthetic-startup-only-no-model-calls", AGENT_TRUST_PROXY: "1" } });
  try {
    const result = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "127.0.0.1", headers: { "x-forwarded-proto": "https" }, payload: { id: "owner", secret: operatorSecret } });
    assert.equal(result.statusCode, 200);
    assert.match(String(result.headers["set-cookie"]), /__Host-agent-session=.*;.*Secure/);
    assert.equal(JSON.stringify(database.sqlite.prepare("select * from auth_sessions").all()).includes(operatorSecret), false);
  } finally { await app.close(); database.sqlite.close(); }
});

test("R2.1 login is rate-limited and payload size is bounded", async () => {
  const { app, database } = await createAgentOpsServer({ env: authEnv });
  try {
    const oversized = await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: "x".repeat(70_000) } });
    assert.equal(oversized.statusCode, 413);
    for (let i = 0; i < 10; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: "wrong" } });
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: operatorSecret } })).statusCode, 429);
  } finally { await app.close(); database.sqlite.close(); }
});

test("R2.1 viewer can read but cannot run, write or approve even with CSRF", async () => {
  const { app, database } = await createAgentOpsServer({ env: authEnv });
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "guest", secret: viewerSecret } });
    assert.equal(login.statusCode, 200);
    const headers = { cookie: login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
    assert.equal((await app.inject({ url: "/api/snapshot", headers })).statusCode, 200);
    for (const url of ["/api/runs/run-now", "/api/memory/entries", "/api/security/tool-check", "/api/security/approvals", "/api/tools/execute"]) {
      assert.equal((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode, 403, url);
    }
    assert.equal(login.json().user.role, "viewer");
    assert.match(String(login.headers["set-cookie"]), /HttpOnly/i);
    assert.match(String(login.headers["set-cookie"]), /SameSite=Strict/i);
  } finally {
    await app.close();
    database.sqlite.close();
  }
});

test("R2.1 operator writes require session CSRF; logout revokes the cookie", async () => {
  const { app, database } = await createAgentOpsServer({ env: authEnv });
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: operatorSecret } });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    for (const csrf of [undefined, "forged"]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/runs/run-now", headers: { cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) } })).statusCode, 403);
    }
    const headers = { cookie, "x-csrf-token": login.json().csrfToken };
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/memory/export", headers })).statusCode, 401);
  } finally {
    await app.close();
    database.sqlite.close();
  }
});

test("R2.2 login rejects a client role and cross-origin requests", async () => {
  const { app, database } = await createAgentOpsServer({ env: authEnv });
  try {
    const forged = await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "guest", secret: viewerSecret, role: "operator" } });
    assert.equal(forged.statusCode, 400);
    const crossOrigin = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "https://attacker.test" }, payload: { id: "owner", secret: operatorSecret } });
    assert.equal(crossOrigin.statusCode, 403);
    const wrongSecret = await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: "wrong" } });
    assert.equal(wrongSecret.statusCode, 401);
  } finally {
    await app.close();
    database.sqlite.close();
  }
});
