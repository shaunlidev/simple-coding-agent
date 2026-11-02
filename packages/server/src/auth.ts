import cookie from "@fastify/cookie";
import session, { type SessionStore } from "@fastify/session";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqliteDatabase } from "@simple-coding-agent/db";
import { parseAuthUsers, equalSecret, type AgentEnvironment } from "@simple-coding-agent/security";
export { parseAuthUsers } from "@simple-coding-agent/security";
import type { SQLiteRuntimeStore } from "@simple-coding-agent/runtime";
import { z } from "zod";

const sessionTtlMs = 8 * 60 * 60 * 1000;
const loginSchema = z.object({ id: z.string().max(64), secret: z.string().max(256) }).strict();

declare module "fastify" {
  interface Session {
    userId?: string;
    credentialVersion?: string;
    csrfToken?: string;
    authenticatedAt?: number;
  }
}

const storedSessionSchema = z.object({
  cookie: z.object({
    originalMaxAge: z.number().nullable(),
    expires: z.coerce.date().nullable().optional(),
    maxAge: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.union([z.boolean(), z.literal("auto")]).optional(),
    sameSite: z.union([z.boolean(), z.enum(["lax", "strict", "none"])]).optional(),
    path: z.string().optional(),
  }).passthrough(),
  userId: z.string().optional(),
  credentialVersion: z.string().optional(),
  csrfToken: z.string().optional(),
  authenticatedAt: z.number().optional(),
  __fastifySessionMetadata: z.object({ generation: z.string() }).passthrough().optional(),
}).passthrough();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function missingSession() {
  return Object.assign(new Error("Session expired or revoked"), { code: "ENOENT" });
}

export function createSessionStore(database: SqliteDatabase): SessionStore {
  const { sqlite } = database;
  function serialize(id: string, value: Parameters<SessionStore["set"]>[1]) {
    const serialized = JSON.stringify(value);
    const parsed = storedSessionSchema.parse(JSON.parse(serialized));
    const expires = Math.min(parsed.cookie.expires?.getTime() ?? Date.now() + sessionTtlMs, (parsed.authenticatedAt ?? Date.now()) + sessionTtlMs);
    return { serialized, generation: parsed.__fastifySessionMetadata?.generation ?? id, expires };
  }
  return {
    set(id, value, callback) {
      try {
        const data = serialize(id, value);
        sqlite.prepare("delete from auth_sessions where expires_at <= ?").run(Date.now());
        const result = sqlite.prepare("insert into auth_sessions (id_hash, generation, payload_json, expires_at) values (?, ?, ?, ?) on conflict do nothing")
          .run(digest(id), data.generation, data.serialized, data.expires);
        callback(result.changes === 1 ? undefined : missingSession());
      } catch { callback(new Error("Session persistence failed")); }
    },
    get(id, callback) {
      try {
        const row = sqlite.prepare("select payload_json from auth_sessions where id_hash = ? and expires_at > ?").get(digest(id), Date.now());
        if (!row) { callback(null, null); return; }
        const { payload_json } = z.object({ payload_json: z.string() }).parse(row);
        callback(null, storedSessionSchema.parse(JSON.parse(payload_json)));
      } catch { callback(new Error("Session read failed")); }
    },
    compareAndSet(id, expectedGeneration, value, callback) {
      try {
        const data = serialize(id, value);
        // Conditional update prevents an in-flight response from resurrecting a logged-out session.
        const result = sqlite.prepare("update auth_sessions set generation = ?, payload_json = ?, expires_at = ? where id_hash = ? and generation = ? and expires_at > ?")
          .run(data.generation, data.serialized, data.expires, digest(id), expectedGeneration, Date.now());
        callback(result.changes === 1 ? undefined : missingSession());
      } catch { callback(new Error("Session update failed")); }
    },
    destroy(id, callback) {
      try { sqlite.prepare("delete from auth_sessions where id_hash = ?").run(digest(id)); callback(); }
      catch { callback(new Error("Session revocation failed")); }
    },
  };
}

export async function registerAuthentication(app: FastifyInstance, env: AgentEnvironment, runtime: SQLiteRuntimeStore, users = parseAuthUsers(env)) {
  const versions = new Map(users.map((user) => [user.id, digest(`${user.role}:${user.secret}`)]));
  const cookieName = env.NODE_ENV === "production" ? "__Host-agent-session" : "agent-session";
  await app.register(cookie);
  await app.register(session, {
    secret: env.AGENT_SESSION_SECRET ?? randomBytes(32).toString("hex"),
    cookieName,
    store: createSessionStore(runtime.database),
    saveUninitialized: false,
    rolling: false,
    cookie: { path: "/", httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "strict", maxAge: sessionTtlMs },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  function currentUser(request: FastifyRequest) {
    const user = users.find((candidate) => candidate.id === request.session.userId);
    if (!user || !request.session.authenticatedAt || Date.now() - request.session.authenticatedAt >= sessionTtlMs) return undefined;
    if (request.session.credentialVersion !== versions.get(user.id)) return undefined;
    return { id: user.id, role: user.role };
  }

  async function audit(request: FastifyRequest, action: string, decision: "allowed" | "denied", actor = currentUser(request)?.id ?? "anonymous") {
    await runtime.recordSecurityAudit({ action, severity: decision === "denied" ? "warning" : "info", message: JSON.stringify({ actor, decision, requestId: request.id }) });
  }

  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    reply.header("cache-control", "no-store");
    const writing = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const origin = request.headers.origin;
    if (writing && origin && ![env.AGENT_CORS_ORIGIN, env.AGENT_PUBLIC_ORIGIN].includes(origin)) {
      await audit(request, "origin.check", "denied");
      return reply.code(403).send({ error: { code: "ORIGIN_DENIED", message: "Request origin is not allowed" } });
    }
    if (path === "/api/auth/login" && request.method === "POST") return;
    const user = currentUser(request);
    if (!user) {
      await audit(request, path, "denied");
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "Sign in required" } });
    }
    if (writing && user.role !== "operator" && path !== "/api/auth/logout") {
      await audit(request, request.routeOptions.url ?? path, "denied");
      return reply.code(403).send({ error: { code: "OPERATOR_REQUIRED", message: "Operator permission required" } });
    }
    if (writing && (typeof request.headers["x-csrf-token"] !== "string" || !request.session.csrfToken || !equalSecret(request.headers["x-csrf-token"], request.session.csrfToken))) {
      await audit(request, "csrf.check", "denied");
      return reply.code(403).send({ error: { code: "CSRF_REQUIRED", message: "Session CSRF token required" } });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const action = request.routeOptions.url ?? "";
    if (action.startsWith("/api/") && !action.startsWith("/api/auth/") && !["GET", "HEAD", "OPTIONS"].includes(request.method) && reply.statusCode >= 200 && reply.statusCode < 300) {
      await audit(request, action, "allowed");
    }
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_LOGIN", message: "Provide id and secret only" } });
    const user = users.find((candidate) => candidate.id === parsed.data.id);
    const matches = equalSecret(parsed.data.secret, user?.secret ?? "invalid-unconfigured-identity-credential");
    if (!user || !matches) {
      await audit(request, "login", "denied");
      return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
    }
    await request.session.regenerate();
    request.session.userId = user.id;
    request.session.credentialVersion = versions.get(user.id);
    request.session.csrfToken = randomBytes(32).toString("hex");
    request.session.authenticatedAt = Date.now();
    await request.session.save();
    await audit(request, "login", "allowed", user.id);
    return { user: { id: user.id, role: user.role }, csrfToken: request.session.csrfToken };
  });
  app.get("/api/auth/session", async (request) => ({ user: currentUser(request), csrfToken: request.session.csrfToken }));
  app.post("/api/auth/logout", async (request, reply) => {
    await audit(request, "logout", "allowed");
    await request.session.destroy();
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });
  return { currentUser, audit };
}
