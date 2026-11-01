import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeScheduler, SQLiteRuntimeStore, contentTaskSchema, executeContentRun, nextRunAt, type ContentProviderFactory, type RuntimeSchedule } from "@simple-coding-agent/runtime";
import { createDeepSeekProvider } from "@simple-coding-agent/ai";
import { SafeNetwork, createCloudflareResolver, createRedactor, evaluateToolCall, parseEnvironment, parseUrlAllowlist, redactSecrets, scanForSecrets } from "@simple-coding-agent/security";
import { z } from "zod";
import { parseAuthUsers, registerAuthentication } from "./auth.js";
import { GuardedToolExecutor } from "./tool-executor.js";

export type AgentOpsServerOptions = {
  env?: Record<string, string | undefined>;
  logger?: boolean;
  logStream?: { write: (message: string) => void };
  startScheduler?: boolean;
  now?: () => Date;
  dashboardRoot?: string;
  providerFactory?: ContentProviderFactory;
  network?: SafeNetwork;
};

const createScheduleSchema = z.object({
  taskId: z.string().min(1).optional(),
  id: z.string().min(1),
  title: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1).default("Asia/Shanghai"),
  enabled: z.boolean().default(true),
  overlapPolicy: z.enum(["skip", "queue", "cancel_previous"]).default("skip"),
}).strict();

const patchScheduleSchema = z.object({
  taskId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  overlapPolicy: z.enum(["skip", "queue", "cancel_previous"]).optional(),
}).strict();

const schedulerTickSchema = z.object({}).strict();

const feedbackSchema = z.object({
  itemId: z.string().min(1),
  signal: z.enum(["clicked", "saved", "not_interested", "dismissed"]),
});

const memoryEntrySchema = z.object({
  kind: z.enum(["preference", "blocked_topic", "source_weight", "lesson", "knowledge"]),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const toolCheckSchema = z.object({
  toolName: z.string().min(1),
  url: z.string().url().optional(),
}).strict();

const operationSchema = z.object({ runId: z.string().min(1), tool: z.string().min(1), args: z.json() }).strict();
const executeSchema = operationSchema.extend({ approvalId: z.string().uuid().optional() }).strict();

const secretScanSchema = z.object({
  text: z.string(),
});

function errorEnvelope(error: unknown, redactor = createRedactor()) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      code: "AGENT_OPS_ERROR",
      message: redactor.text(message),
    },
  };
}

function redactForResponse(value: unknown): unknown {
  return createRedactor().value(value);
}

async function sendSseSnapshot(reply: FastifyReply, runtime: SQLiteRuntimeStore, closeAfterFirst: boolean) {
  const snapshot = await runtime.snapshot();
  reply.raw.write(`event: snapshot\ndata: ${runtime.redactor.json(snapshot)}\n\n`);
  for (const event of snapshot.events.slice().reverse()) {
    reply.raw.write(`event: runtime-event\ndata: ${runtime.redactor.json(event)}\n\n`);
  }
  if (closeAfterFirst) reply.raw.end();
}

export async function createAgentOpsServer(options: AgentOpsServerOptions = {}) {
  const env = parseEnvironment(options.env ?? process.env);
  const users = parseAuthUsers(env);
  const urlAllowlist = parseUrlAllowlist(env.AGENT_URL_ALLOWLIST);
  if (env.AGENT_DB_PATH !== ":memory:") mkdirSync(dirname(env.AGENT_DB_PATH), { recursive: true });
  const runtime = new SQLiteRuntimeStore({ path: env.AGENT_DB_PATH, network: options.network ?? new SafeNetwork({ allowlist: urlAllowlist, ...(env.AGENT_DNS_MODE === "cloudflare" ? { resolve: createCloudflareResolver() } : {}) }), secrets: [env.DEEPSEEK_API_KEY ?? "", env.AGENT_SESSION_SECRET ?? "", ...users.map((user) => user.secret)] });
  const providerFactory: ContentProviderFactory = options.providerFactory ?? ((task) => {
    if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for real content runs");
    return createDeepSeekProvider({ apiKey: env.DEEPSEEK_API_KEY, model: task.model, stream: true, maxOutputTokens: task.limits.maxOutputTokens, responseFormat: "json_object", toolChoice: "required" });
  });
  const scheduler = new RuntimeScheduler({ runtime, now: options.now, ...(env.AGENT_DEMO_MODE === "1" ? {} : { runAgent: ({ runId, signal }: { runId: string; signal: AbortSignal }) => executeContentRun(runtime, runId, { providerFactory, signal, alreadyStarted: true }) }) });
  const app = Fastify({
    logger: options.logger ? {
      ...(options.logStream ? { stream: options.logStream } : {}),
      serializers: { req: (request) => ({ method: request.method, url: runtime.redactor.text(request.url), id: request.id }), res: (reply) => ({ statusCode: reply.statusCode }) },
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"],
    } : false,
    bodyLimit: 64 * 1024,
    trustProxy: env.AGENT_TRUST_PROXY === "1" ? "loopback" : false,
  });

  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as { statusCode?: number };
    const statusCode = error instanceof z.ZodError ? 400 : candidate.statusCode && candidate.statusCode >= 400 && candidate.statusCode < 600 ? candidate.statusCode : 500;
    reply.status(statusCode).send(errorEnvelope(error, runtime.redactor));
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.routeOptions.url?.startsWith("/api/auth/")) return payload;
    if (typeof payload === "string" && String(reply.getHeader("content-type")).includes("application/json")) {
      return runtime.redactor.json(JSON.parse(payload));
    }
    return payload;
  });

  await app.register(cors, { origin: env.AGENT_CORS_ORIGIN, credentials: true });
  const auth = await registerAuthentication(app, env, runtime, users);
  const executor = new GuardedToolExecutor({ runtime, tools: new Map([
    ["memory_clear", { requiresApproval: true, parameters: z.object({ confirmation: z.literal("clear-memory") }).strict(), execute: async () => { await runtime.clearMemory(); return { ok: true }; } }],
  ]) });

  const dashboardRoot = options.dashboardRoot ?? fileURLToPath(new URL("../../dashboard/dist/", import.meta.url));
  if (existsSync(dashboardRoot)) {
    await app.register(fastifyStatic, { root: dashboardRoot, index: "index.html", maxAge: 0, wildcard: true, list: false });
  }

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async () => {
    runtime.database.sqlite.prepare("select 1").get();
    return { ok: true, database: "connected" };
  });

  app.get("/api/snapshot", async () => redactForResponse(await runtime.snapshot()));

  app.get("/api/runs", async () => ({ runs: await runtime.listRuns() }));

  app.get("/api/runs/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const detail = runtime.readRunDetail(request.params.id);
    if (!detail) {
      reply.status(404);
      return { error: { code: "RUN_NOT_FOUND", message: "Run not found" } };
    }
    return redactForResponse(detail);
  });

  app.get("/api/events", async (request) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const severity = url.searchParams.get("severity");
    const source = url.searchParams.get("source");
    const runId = url.searchParams.get("runId") ?? undefined;
    const events = await runtime.listEvents(runId);
    return {
      events: redactForResponse(events.filter((event) =>
        (!severity || event.severity === severity) &&
        (!source || event.source === source),
      )),
    };
  });

  if (options.startScheduler) scheduler.start();
  app.addHook("onClose", async () => {
    await scheduler.stop();
  });

  function runRequest(request: FastifyRequest) {
    const actor = auth.currentUser(request);
    if (!actor) throw Object.assign(new Error("Sign in required"), { statusCode: 401 });
    const key = z.string().min(1).max(128).parse(request.headers["idempotency-key"] ?? randomUUID());
    return { actor: actor.id, key };
  }

  app.post("/api/runs/run-now", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const body = z.object({ taskId: z.string().min(1).optional() }).strict().parse(request.body ?? {});
    const identity = runRequest(request);
    if (!body.taskId && env.AGENT_DEMO_MODE === "1") return { accepted: true, runId: await scheduler.runNow(undefined, identity) };
    const taskId = z.string().min(1, "Select a configured content task").parse(body.taskId ?? "");
    return { accepted: true, runId: await scheduler.runTask(taskId, identity) };
  });

  app.post("/api/runs/:id/cancel", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    z.object({}).strict().parse(request.body ?? {});
    return scheduler.cancel(request.params.id, auth.currentUser(request)?.id ?? "unknown");
  });
  app.get("/api/scheduler/jobs", async () => ({ jobs: scheduler.listJobs() }));

  app.get("/api/tasks", async () => ({ tasks: runtime.listContentTasks(), demoMode: env.AGENT_DEMO_MODE === "1", defaultModel: env.DEEPSEEK_MODEL }));
  app.put("/api/tasks/:id", async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const input = z.object({ definition: contentTaskSchema, expectedRevision: z.number().int().nonnegative() }).strict().parse(request.body);
    if (input.definition.id !== request.params.id) throw Object.assign(new Error("Task ID mismatch"), { statusCode: 400 });
    for (const source of input.definition.sources) {
      try { await runtime.network.validate(source.url); }
      catch { throw Object.assign(new Error(`Source ${source.id} is outside the configured network policy or unavailable`), { statusCode: 400 }); }
    }
    return runtime.saveContentTask(input.definition, input.expectedRevision);
  });

  app.post("/api/schedules/:id/run-now", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request: FastifyRequest<{ Params: { id: string } }>) => {
    z.object({}).strict().parse(request.body ?? {});
    if (env.AGENT_DEMO_MODE !== "1") {
      const schedule = (await runtime.readSchedules()).find((schedule) => schedule.id === request.params.id);
      if (!schedule?.taskId) throw Object.assign(new Error("Schedule has no configured content task"), { statusCode: 400 });
    }
    const runId = await scheduler.runNow(request.params.id, runRequest(request));
    return { accepted: true, runId };
  });

  app.post("/api/scheduler/tick", async (request, reply) => {
    const parsed = schedulerTickSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "INVALID_SCHEDULER_TICK", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    }
    const results = await scheduler.tick(options.now?.() ?? new Date());
    return { results };
  });

  app.get("/api/events/stream", async (request, reply) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const once = url.searchParams.get("once") === "1";
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: once ? "close" : "keep-alive",
    });
    await sendSseSnapshot(reply, runtime, once);
    if (once) return reply;
    const timer = setInterval(() => {
      request.session.reload().then(async () => {
        if (!auth.currentUser(request)) { clearInterval(timer); reply.raw.end(); return; }
        await sendSseSnapshot(reply, runtime, false);
      }).catch(() => { clearInterval(timer); reply.raw.end(); });
    }, 1000);
    request.raw.on("close", () => clearInterval(timer));
    return reply;
  });

  app.get("/api/schedules", async () => ({ schedules: await runtime.readSchedules() }));

  app.get("/api/security/audit", async () => redactForResponse({
    audit: await runtime.listSecurityAudit(),
    approvals: executor.listApprovals(),
  }));

  app.post("/api/security/tool-check", async (request, reply) => {
    const parsed = toolCheckSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "INVALID_TOOL_CHECK", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    }
    const decision = evaluateToolCall({ ...parsed.data, allowlist: urlAllowlist });
    if (!decision.allowed) {
      await runtime.recordSecurityAudit({
        action: decision.tool,
        severity: "warning",
        message: redactSecrets(decision.reason),
      });
      reply.status(403);
    }
    return redactForResponse({ decision });
  });

  app.post("/api/security/secret-scan", async (request, reply) => {
    const parsed = secretScanSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "INVALID_SECRET_SCAN", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    }
    const result = scanForSecrets(parsed.data.text);
    await runtime.recordSecurityAudit({
      action: "secret_scan",
      severity: result.passed ? "info" : "error",
      message: result.passed ? "Secret scan passed" : `Secret scan found ${result.findings.length} finding(s)`,
    });
    return redactForResponse(result);
  });

  app.get("/api/memory/export", async () => await runtime.exportMemory());

  app.post("/api/security/approvals", async (request, reply) => {
    const parsed = operationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_OPERATION", message: "Provide runId, registered tool and arguments only" } });
    const actor = auth.currentUser(request);
    if (!actor) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    return executor.requestApproval({ ...parsed.data, actor: actor.id });
  });

  app.post("/api/security/approvals/:id/approve", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!z.object({}).strict().safeParse(request.body ?? {}).success) return reply.code(400).send({ error: { code: "INVALID_APPROVAL", message: "Approver identity is supplied by the session" } });
    const actor = auth.currentUser(request);
    if (!actor) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    return executor.approve(request.params.id, actor.id);
  });

  app.post("/api/tools/execute", async (request, reply) => {
    const parsed = executeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_OPERATION" } });
    const actor = auth.currentUser(request);
    if (!actor) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    return executor.execute({ ...parsed.data, actor: actor.id });
  });

  app.delete("/api/memory", async (request, reply) => {
    const parsed = z.object({ runId: z.string().min(1), approvalId: z.string().uuid() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "APPROVAL_REQUIRED", message: "A bound memory_clear approval is required" } });
    const actor = auth.currentUser(request);
    if (!actor) return reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
    return executor.execute({ ...parsed.data, actor: actor.id, tool: "memory_clear", args: { confirmation: "clear-memory" } });
  });

  app.get("/api/memory/search", async (request, reply) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const q = url.searchParams.get("q")?.trim();
    if (!q) {
      reply.status(400);
      return { error: { code: "INVALID_MEMORY_QUERY", message: "q is required" } };
    }
    return { results: await runtime.searchMemory(q) };
  });

  app.post("/api/memory/feedback", async (request, reply) => {
    const parsed = feedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "INVALID_FEEDBACK", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    }
    await runtime.recordFeedback(parsed.data.itemId, parsed.data.signal);
    return { ok: true, memory: await runtime.readMemory() };
  });

  app.post("/api/memory/entries", async (request, reply) => {
    const parsed = memoryEntrySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "INVALID_MEMORY_ENTRY", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    }
    try {
      return await runtime.writeMemoryEntry({ ...parsed.data, sourceTrust: "user" });
    } catch (error) {
      await runtime.appendEvent(runtime.createEvent(`memory-denied-${Date.now().toString(36)}`, "security.policy.denied", {
        action: "memory.write",
        reason: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
      }, { source: "security", severity: "warning" }));
      reply.status(400);
      return { error: { code: "MEMORY_WRITE_DENIED", message: error instanceof Error ? redactSecrets(error.message) : "Memory write denied" } };
    }
  });

  app.post("/api/schedules", async (request, reply) => {
    const parsed = createScheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "INVALID_SCHEDULE", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    }
    const schedule: RuntimeSchedule = {
      id: parsed.data.id,
      title: parsed.data.title,
      enabled: parsed.data.enabled,
      cron: parsed.data.cron,
      timezone: parsed.data.timezone,
      nextRunAt: nextRunAt(parsed.data, options.now?.() ?? new Date()),
      overlapPolicy: parsed.data.overlapPolicy,
      ...(parsed.data.taskId ? { taskId: parsed.data.taskId } : {}),
    };
    if (env.AGENT_DEMO_MODE !== "1" && !schedule.taskId) throw Object.assign(new Error("A configured task is required for scheduling"), { statusCode: 400 });
    if (schedule.taskId && !runtime.listContentTasks().some((task) => task.definition.id === schedule.taskId)) throw Object.assign(new Error("Content task not found"), { statusCode: 400 });
    return await runtime.createSchedule(schedule);
  });

  app.patch("/api/schedules/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const parsed = patchScheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "INVALID_SCHEDULE_PATCH", message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    }
    if (env.AGENT_DEMO_MODE !== "1") {
      const current = (await runtime.readSchedules()).find((schedule) => schedule.id === request.params.id);
      const taskId = parsed.data.taskId ?? current?.taskId;
      if ((parsed.data.enabled ?? current?.enabled) && !taskId) throw Object.assign(new Error("Bind a configured task before enabling this schedule"), { statusCode: 400 });
      if (taskId && !runtime.listContentTasks().some((task) => task.definition.id === taskId)) throw Object.assign(new Error("Content task not found"), { statusCode: 400 });
    }
    return await runtime.updateSchedule(request.params.id, parsed.data, options.now?.() ?? new Date());
  });

  return { app, runtime, scheduler, database: runtime.database };
}
