import assert from "node:assert/strict";
import type { InjectOptions } from "fastify";
import { createAgentOpsServer, type AgentOpsServerOptions } from "../src/index.ts";

export const operatorSecret = "test-operator-credential-with-32-bytes";
export const viewerSecret = "test-viewer-credential-with-32-bytes";
export const authEnv = {
  AGENT_DB_PATH: ":memory:",
  AGENT_DEMO_MODE: "1",
  AGENT_SESSION_SECRET: "test-session-signing-secret-with-32-bytes",
  AGENT_AUTH_USERS: JSON.stringify([
    { id: "owner", role: "operator", secret: operatorSecret },
    { id: "guest", role: "viewer", secret: viewerSecret },
  ]),
};

export async function createAuthenticatedServer(options: AgentOpsServerOptions = {}) {
  const server = await createAgentOpsServer({ ...options, env: { ...authEnv, ...options.env } });
  const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "owner", secret: operatorSecret } });
  assert.equal(login.statusCode, 200);
  const headers = { cookie: login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
  return { ...server, request: (options: InjectOptions) => server.app.inject({ ...options, headers: { ...headers, ...options.headers } }) };
}
