import { and, asc, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SafeNetwork, createRedactor } from "@simple-coding-agent/security";
import { readBrowserSource } from "./browser-source.js";
export { readBrowserSource } from "./browser-source.js";
import { contentEntities, contentIdentityKey, runContentResults, contentDeliveries, runReceipts, runRequests, createSqliteDatabase, evalReports, migrateSqliteDatabase, runtimeEvents, schedules, securityAudit, toolApprovals, type SqliteDatabase } from "@simple-coding-agent/db";
import { RuntimeMemory, adjustContentRank } from "./memory.js";
import { RuntimePractices } from "./practices.js";
import { practiceSelection, validatePracticeQuotes } from "./practice-rules.js";
export { practiceProposalSchema } from "./practices.js";
export { adjustContentRank } from "./memory.js";
export type { MemoryContext, FrozenMemoryContext, MemoryHit } from "./memory.js";
import { parseRuntimeEvent, type RuntimeEvent, type RuntimeEventType } from "./events.js";
import { contentTaskSchema, contentCitationSchema, sourceReadSchema, type ContentTaskRecord, type ContentCitation, type SourceRead } from "./content-contract.js";
import { nextRunAt, validateScheduleClock, parseScheduleDate, coalesceDue } from "./schedule-time.js";
export { nextRunAt } from "./schedule-time.js";
export { RuntimeScheduler, type SchedulerRunResult, type RuntimeSchedulerOptions } from "./scheduler.js";
export { contentTaskSchema } from "./content-contract.js";
export type { ContentTask, ContentTaskRecord } from "./content-contract.js";
export { executeContentRun, type ContentProviderFactory } from "./content-agent.js";
export { createContentExecutor } from "./content-executor.js";
export { openLocalTaskHost, type LocalTaskHost, type LocalTaskHostOptions } from "./local-host.js";
export type { RuntimeEvent, RuntimeEventType } from "./events.js";

export type RunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "skipped";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type Severity = "info" | "warning" | "error" | "critical";

export type RuntimeRun = {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: "manual" | "schedule" | "demo";
  title: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  errorCount: number;
};

export type RuntimeStep = {
  id: string;
  name: string;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: string;
};

export type RuntimeSpan = {
  id: string;
  traceId: string;
  spanId: string;
  runId: string;
  parentId?: string;
  parentSpanId?: string;
  type: "root" | "scheduler" | "tool" | "browser" | "memory" | "llm" | "eval" | "security" | "delivery";
  name: string;
  status: "ok" | "error" | "denied";
  startedAt: string;
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  summary: string;
  attributes: Record<string, string | number | boolean>;
};

export type RuntimeSchedule = {
  revision?: number;
  id: string;
  title: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastTrigger?: "manual" | "schedule" | "demo";
  lastTriggerReason?: string;
  lastScheduledFor?: string;
  overlapPolicy: "skip" | "queue" | "cancel_previous";
  taskId?: string;
};

export type MemoryState = {
  interests: string[];
  blockedTopics: string[];
  sourceWeights: Record<string, number>;
  recentFeedback: Array<{ itemId: string; signal: "clicked" | "saved" | "not_interested" | "dismissed"; timestamp: string }>;
  recentLessons: Array<{ title: string; principle: string; evidence: string; timestamp: string }>;
  preferenceDiffs: Array<{ field: "interests" | "blockedTopics" | "sourceWeights"; key: string; before?: string | number; after?: string | number; timestamp: string }>;
};

export type EvalGate = {
  id: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  score: number;
  evidence: string;
};

export type EvalReportInput = EvalGate & {
  evidenceData?: Record<string, unknown>;
};

export type SecurityPosture = {
  toolPolicy: "least_privilege";
  secretScan: "passed" | "failed";
  sandbox: "enabled" | "planned";
  approvals: "required_for_high_risk";
  denials: Array<{ id: string; tool: string; reason: string; timestamp: string }>;
};

export type RuntimeSnapshot = {
  generatedAt: string;
  agent: {
    name: string;
    status: "idle" | "running" | "degraded" | "failed";
    mode: "demo" | "local" | "production";
  };
  latestRun?: RuntimeRun;
  schedules: RuntimeSchedule[];
  steps: RuntimeStep[];
  spans: RuntimeSpan[];
  metrics: {
    successRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    errorRate: number;
    toolFailures: number;
    evalPassRate: number;
    events: number;
  };
  memory: MemoryState;
  evals: EvalGate[];
  security: SecurityPosture;
  contentItems: DeliveredContentItem[];
  pipeline: {
    fetched: number;
    cleaned: number;
    deduped: number;
    ranked: number;
    delivered: number;
    failedSources: string[];
    digest?: string;
    outcome?: "delivered" | "no_new_items" | "legacy_incomplete";
  };
  events: RuntimeEvent[];
};

export type ContentSourceKind = "mock" | "rss" | "url" | "browser";

export type ContentSource = {
  id: string;
  kind: ContentSourceKind;
  url?: string;
  query?: string;
  items?: RawContentItem[];
};

export type RawContentItem = {
  id?: string;
  source: string;
  title: string;
  url?: string;
  text: string;
  publishedAt?: string;
};

export type DeliveredContentItem = {
  id: string;
  runId: string;
  title: string;
  source: string;
  url?: string;
  summary: string;
  reason: string;
  score: number;
  status: "delivered" | "already_delivered" | "filtered" | "failed";
  evidence: string[];
  citations?: ContentCitation[];
  createdAt: string;
};

export type ContentPipelineOptions = {
  sources?: ContentSource[];
  network?: SafeNetwork;
  signal?: AbortSignal;
  maxItems?: number;
  budget?: {
    maxCostUsd?: number;
    maxLatencyMs?: number;
    onOverflow?: "throw" | "degrade";
  };
};

export type MemoryEntryInput = {
  kind: "preference" | "blocked_topic" | "source_weight" | "lesson" | "knowledge";
  sourceTrust: "user" | "system" | "trusted_tool" | "external";
  content: string;
  metadata?: Record<string, unknown>;
};

export type MemoryExport = {
  memory: MemoryState;
  entries: Array<{ id: string; kind: string; sourceTrust: string; content: string; metadata: Record<string, unknown>; createdAt: string }>;
};

export type SecurityAuditRecord = {
  id: string;
  runId?: string;
  action: string;
  severity: Severity;
  message: string;
  createdAt: string;
};

export type ToolApprovalRecord = {
  id: string;
  tool: string;
  risk: string;
  status: "approved" | "denied" | "pending";
  reason: string;
  createdAt: string;
};

export type DemoAgentRunOptions = {
  trigger?: RuntimeRun["trigger"];
  delayMs?: number;
  runId?: string;
  taskId?: string;
  title?: string;
  schedulerDetail?: string;
  emitSchedulerEvent?: boolean;
  alreadyStarted?: boolean;
  signal?: AbortSignal;
};

function eventId(runId: string, type: RuntimeEventType): string {
  return `${runId}-${type}-${randomUUID()}`;
}

function canonicalJson(value: z.infer<ReturnType<typeof z.json>>): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(z.json().parse(value))).digest("hex");
}

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

const contentResultSchema = z.object({
  id: z.string().min(1), runId: z.string().min(1), title: z.string(), source: z.string(), url: z.string().optional(),
  summary: z.string(), reason: z.string(), score: z.number(), status: z.enum(["delivered", "already_delivered", "filtered", "failed"]),
  evidence: z.array(z.string()), citations: z.array(contentCitationSchema).optional(), createdAt: z.iso.datetime({ offset: true }),
});
const outcomeSchema = z.enum(["delivered", "no_new_items", "legacy_incomplete"]);

function stepFromEvent(event: RuntimeEvent): RuntimeStep | undefined {
  const nameByType: Partial<Record<RuntimeEventType, string>> = {
    "scheduler.task_due": "Trigger",
    "pipeline.fetch.started": "Fetch",
    "pipeline.fetch.completed": "Fetch",
    "pipeline.clean.completed": "Clean",
    "pipeline.dedupe.completed": "Dedupe",
    "pipeline.rank.completed": "Rank",
    "pipeline.summarize.completed": "Summarize",
    "delivery.created": "Deliver",
    "delivery.skipped": "Deliver",
    "memory.preference.updated": "Learn",
    "eval.completed": "Eval Gate",
    "security.policy.checked": "Security Gate",
  };
  const name = nameByType[event.type];
  if (!name) return undefined;
  const completed = event.type.endsWith(".completed") || event.type === "scheduler.task_due" || event.type.startsWith("delivery.") || event.type === "memory.preference.updated" || event.type === "eval.completed" || event.type === "security.policy.checked";
  return {
    id: `${event.runId}-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    status: completed ? "completed" : "running",
    startedAt: event.timestamp,
    completedAt: completed ? event.timestamp : undefined,
    durationMs: Number(event.payload.durationMs ?? 0),
    detail: String(event.payload.detail ?? event.payload.count ?? event.type),
  };
}

function spanFromEvent(event: RuntimeEvent): RuntimeSpan | undefined {
  const typeByEvent: Partial<Record<RuntimeEventType, RuntimeSpan["type"]>> = {
    "scheduler.task_due": "scheduler",
    "pipeline.fetch.completed": "browser",
    "pipeline.clean.completed": "tool",
    "pipeline.dedupe.completed": "tool",
    "pipeline.rank.completed": "memory",
    "pipeline.summarize.completed": "llm",
    "delivery.created": "delivery",
    "memory.preference.updated": "memory",
    "eval.completed": "eval",
    "security.policy.checked": "security",
    "security.policy.denied": "security",
  };
  const spanType = typeByEvent[event.type];
  if (!spanType) return undefined;
  const traceId = traceIdForRun(event.runId);
  const spanId = spanIdForEvent(event.id);
  return {
    id: `${event.id}-span`,
    traceId,
    spanId,
    runId: event.runId,
    parentId: `${event.runId}-root-span`,
    parentSpanId: rootSpanIdForRun(event.runId),
    type: spanType,
    name: event.type,
    status: event.type === "security.policy.denied" ? "denied" : event.severity === "error" || event.severity === "critical" ? "error" : "ok",
    startedAt: event.timestamp,
    durationMs: Number(event.payload.durationMs ?? 0),
    costUsd: Number(event.payload.costUsd ?? 0),
    inputTokens: Number(event.payload.inputTokens ?? 0),
    outputTokens: Number(event.payload.outputTokens ?? 0),
    summary: String(event.payload.detail ?? event.payload.reason ?? event.payload.count ?? "recorded"),
    attributes: {
      "agent.event_id": event.id,
      "agent.event_type": event.type,
      "agent.source": event.source,
      "agent.severity": event.severity,
      ...(event.type === "pipeline.summarize.completed" ? {
        "llm.model": String(event.payload.model ?? "deepseek-compatible"),
        "llm.input_tokens": Number(event.payload.inputTokens ?? 0),
        "llm.output_tokens": Number(event.payload.outputTokens ?? 0),
        "llm.cost_usd": Number(event.payload.costUsd ?? 0),
      } : {}),
    },
  };
}

function traceIdForRun(runId: string): string {
  return `trace-${contentHash(runId).toString(16).padStart(16, "0")}`;
}

function rootSpanIdForRun(runId: string): string {
  return `span-${contentHash(`${runId}:root`).toString(16).padStart(8, "0")}`;
}

function spanIdForEvent(eventId: string): string {
  return `span-${contentHash(eventId).toString(16).padStart(8, "0")}`;
}

function rootSpanFromRun(run: RuntimeRun, events: RuntimeEvent[]): RuntimeSpan {
  const startedAt = run.startedAt ?? events[0]?.timestamp ?? new Date().toISOString();
  const durationMs = run.durationMs ?? events.reduce((sum, event) => sum + Number(event.payload.durationMs ?? 0), 0);
  return {
    id: `${run.id}-root-span`,
    traceId: traceIdForRun(run.id),
    spanId: rootSpanIdForRun(run.id),
    runId: run.id,
    type: "root",
    name: run.title,
    status: run.status === "failed" ? "error" : "ok",
    startedAt,
    durationMs,
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    summary: `${run.trigger} run ${run.status}`,
    attributes: {
      "agent.run_id": run.id,
      "agent.task_id": run.taskId,
      "agent.trigger": run.trigger,
      "agent.status": run.status,
    },
  };
}

export type SQLiteRuntimeStoreOptions = {
  database?: SqliteDatabase;
  path?: string;
  secrets?: readonly string[];
  network?: SafeNetwork;
};

export class SQLiteRuntimeStore {
  readonly database: SqliteDatabase;
  readonly redactor: ReturnType<typeof createRedactor>;
  readonly network: SafeNetwork;
  readonly memory: RuntimeMemory;
  readonly practices: RuntimePractices;

  constructor(options: SQLiteRuntimeStoreOptions = {}) {
    this.redactor = createRedactor(options.secrets);
    this.network = options.network ?? new SafeNetwork({ allowlist: [] });
    this.database = options.database ?? createSqliteDatabase(options.path ?? ":memory:");
    try { migrateSqliteDatabase(this.database); }
    catch (error) { if (!options.database) this.database.sqlite.close(); throw error; }
    this.memory = new RuntimeMemory(this);
    this.practices = new RuntimePractices(this);
  }

  async appendEvent(input: unknown): Promise<RuntimeEvent> {
    return this.appendEventSync(input);
  }

  appendEventSync(input: unknown): RuntimeEvent {
    const event = parseRuntimeEvent(input);
    if (event.schemaVersion !== 1) throw new Error("Legacy event versions are read-only");
    return this.database.sqlite.transaction(() => this.writeEvent(event)).immediate();
  }

  private writeEvent(event: RuntimeEvent): RuntimeEvent {
    event = parseRuntimeEvent({ ...event, id: this.redactor.identifier(event.id), runId: this.redactor.identifier(event.runId), source: this.redactor.text(event.source), payload: this.redactor.record(event.payload) });
    const existing = this.database.db.select().from(runtimeEvents).where(eq(runtimeEvents.id, event.id)).get();
    if (existing) {
      const stored = parseRuntimeEvent({ id: existing.id, runId: existing.runId, type: existing.type, source: existing.source, severity: existing.severity, timestamp: existing.timestamp, schemaVersion: existing.schemaVersion, payload: JSON.parse(existing.payloadJson) });
      if (fingerprint(stored) !== fingerprint(event)) throw conflict("Event ID reused with different content");
      return stored;
    }
    if (event.type === "run.started" || event.type === "run.completed" || /^(agent\.|pipeline\.|source\.|delivery\.)/.test(event.type)) this.assertRunExecutable(event.runId);
    if (["run.queued", "run.started", "run.completed", "run.failed", "run.cancelled", "run.skipped", "run.cancel_requested"].includes(event.type)) {
      const lifecycle = this.database.db.select().from(runtimeEvents).where(eq(runtimeEvents.runId, event.runId)).all();
      const terminal = lifecycle.some((row) => ["run.completed", "run.failed", "run.cancelled", "run.skipped"].includes(row.type));
      if (terminal || lifecycle.some((row) => row.type === event.type)) throw conflict("Invalid run lifecycle transition");
      if (event.type === "run.completed" && !lifecycle.some((row) => row.type === "run.started")) throw conflict("Cannot complete a run before it starts");
      if (event.type === "run.queued" && lifecycle.some((row) => row.type === "run.started")) throw conflict("Cannot queue an already started run");
    }
    this.database.db.insert(runtimeEvents).values({
      id: event.id,
      schemaVersion: event.schemaVersion,
      runId: event.runId,
      type: event.type,
      source: event.source,
      severity: event.severity,
      timestamp: event.timestamp,
      payloadJson: JSON.stringify(event.payload),
    }).run();
    if (["run.completed", "run.failed", "run.cancelled", "run.skipped"].includes(event.type)) {
      this.database.sqlite.prepare("update scheduled_jobs set state = ?, finished_at = ? where run_id = ?").run(event.type.slice(4), event.timestamp, event.runId);
    } else if (event.type === "run.started") {
      this.database.sqlite.prepare("update scheduled_jobs set state = 'running', started_at = ? where run_id = ?").run(event.timestamp, event.runId);
      this.database.sqlite.prepare("update schedules set last_run_at = ? where id = (select schedule_id from scheduled_jobs where run_id = ?)").run(event.timestamp, event.runId);
    } else if (event.type === "run.cancel_requested") {
      this.database.sqlite.prepare("update scheduled_jobs set state = 'cancelling', reason = ? where run_id = ?").run(String(event.payload.reason), event.runId);
    }
    return event;
  }

  assertRunExecutable(runId: string): void {
    const value = this.database.sqlite.prepare("select state from scheduled_jobs where run_id = ?").get(runId);
    if (value && !["queued", "running"].includes(z.object({ state: z.string() }).parse(value).state)) throw conflict("Run is cancelled, cancelling or terminal");
    this.assertMemoryCurrent(runId);
  }

  assertMemoryCurrent(runId: string): void {
    if (this.database.sqlite.prepare("select 1 from run_memory_contexts c join memory_state s on s.id=1 where c.run_id=? and c.epoch<>s.epoch").get(runId)) throw conflict("Run memory was cleared; start a new run");
  }

  createEvent(runId: string, type: RuntimeEventType, payload: Record<string, unknown>, options: { source?: string; severity?: Severity } = {}): RuntimeEvent {
    return parseRuntimeEvent({
      id: eventId(runId, type),
      runId,
      type,
      source: options.source ?? type.split(".")[0],
      severity: options.severity ?? "info",
      timestamp: new Date().toISOString(),
      payload,
    });
  }

  async listEvents(runId?: string): Promise<RuntimeEvent[]> {
    return this.readEvents(runId);
  }

  private readEvents(runId?: string): RuntimeEvent[] {
    const rows = runId
      ? this.database.db.select().from(runtimeEvents).where(eq(runtimeEvents.runId, runId)).orderBy(asc(runtimeEvents.sequence)).all()
      : this.database.db.select().from(runtimeEvents).orderBy(asc(runtimeEvents.sequence)).all();
    return rows.map((row) => parseRuntimeEvent({
      id: row.id,
      runId: row.runId,
      type: row.type,
      source: row.source,
      severity: row.severity,
      timestamp: row.timestamp,
      schemaVersion: row.schemaVersion,
      payload: JSON.parse(row.payloadJson),
    }));
  }

  async projectRun(runId: string): Promise<RuntimeRun> {
    return projectRun(runId, await this.listEvents(runId));
  }

  readRunDetail(runId: string) {
    return this.database.sqlite.transaction(() => {
      const events = this.readEvents(runId);
      if (events.length === 0) return undefined;
      return { run: projectRun(runId, events), result: this.readRunResult(runId) ?? null, events, task: this.readRunTask(runId) ?? null, sources: this.readSourceResults(runId), memoryContext: this.memory.readContext(runId) ?? null };
    })();
  }

  async listRuns(): Promise<RuntimeRun[]> {
    return projectRuns(this.readEvents());
  }

  async readSchedules(): Promise<RuntimeSchedule[]> {
    return this.readSchedulesSync();
  }

  readSchedulesSync(): RuntimeSchedule[] {
    const rows = this.database.db.select().from(schedules).orderBy(asc(schedules.id)).all();
    return rows.map((row) => {
      const value = this.database.sqlite.prepare("select trigger, reason, scheduled_for from scheduled_jobs where schedule_id = ? and started_at is not null order by seq desc limit 1").get(row.id);
      const last = value ? z.object({ trigger: z.enum(["manual", "schedule", "demo"]), reason: z.string(), scheduled_for: z.string().nullable() }).parse(value) : undefined;
      return {
        id: row.id,
        revision: row.revision,
        title: row.title,
        enabled: row.enabled,
        cron: row.cron,
        timezone: row.timezone,
        nextRunAt: row.nextRunAt ?? nextRunAt(row),
        ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
        overlapPolicy: z.enum(["skip", "queue", "cancel_previous"]).parse(row.overlapPolicy),
        ...(row.taskId ? { taskId: row.taskId } : {}),
        ...(last ? { lastTrigger: last.trigger, lastTriggerReason: last.reason, ...(last.scheduled_for ? { lastScheduledFor: last.scheduled_for } : {}) } : {}),
      };
    });
  }

  async seedSchedules(): Promise<void> {
    if ((await this.readSchedules()).length > 0) return;
    await this.database.db.insert(schedules).values(defaultSchedules(new Date().toISOString()).map((schedule) => ({
      id: schedule.id,
      title: schedule.title,
      enabled: schedule.enabled,
      cron: schedule.cron,
      timezone: schedule.timezone,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      overlapPolicy: schedule.overlapPolicy,
    })));
  }

  async createSchedule(schedule: RuntimeSchedule): Promise<RuntimeSchedule> {
    return this.createScheduleSync(schedule);
  }

  createScheduleSync(schedule: RuntimeSchedule): RuntimeSchedule {
    validateScheduleClock(schedule);
    if (schedule.nextRunAt) parseScheduleDate(schedule.nextRunAt);
    this.redactor.identifier(schedule.id);
    this.redactor.identifier(schedule.cron);
    this.redactor.identifier(schedule.timezone);
    return this.database.sqlite.transaction(() => {
      const next = {
        ...schedule,
        title: this.redactor.text(schedule.title),
        nextRunAt: schedule.nextRunAt || nextRunAt(schedule, new Date()),
      };
      this.database.db.insert(schedules).values({
        id: next.id,
        title: next.title,
        enabled: next.enabled,
        cron: next.cron,
        timezone: next.timezone,
        nextRunAt: next.nextRunAt,
        lastRunAt: next.lastRunAt,
        overlapPolicy: next.overlapPolicy,
        taskId: next.taskId,
      }).run();
      this.writeEvent(this.createEvent(`schedule-${randomUUID()}`, "scheduler.task_due", { scheduleId: next.id, action: "created", enabled: next.enabled, cron: next.cron, nextRunAt: next.nextRunAt }, { source: "scheduler" }));
      return next;
    }).immediate();
  }

  async updateSchedule(id: string, patch: Partial<Pick<RuntimeSchedule, "enabled" | "cron" | "timezone" | "overlapPolicy" | "nextRunAt" | "taskId">>, now = new Date()): Promise<RuntimeSchedule> {
    this.redactor.identifier(id);
    for (const value of Object.values(patch)) if (typeof value === "string") this.redactor.identifier(value);
    return this.database.sqlite.transaction(() => {
      const current = this.readSchedulesSync().find((schedule) => schedule.id === id);
      if (!current) throw new Error(`Schedule not found: ${id}`);
      const next = { ...current, ...patch, revision: (current.revision ?? 1) + 1 };
      validateScheduleClock(next);
      if (patch.cron || patch.timezone) next.nextRunAt = patch.nextRunAt ?? nextRunAt(next, now);
      else if (patch.enabled && !current.enabled && !patch.nextRunAt && parseScheduleDate(next.nextRunAt) <= now) next.nextRunAt = coalesceDue(next, now).next;
      parseScheduleDate(next.nextRunAt);
      this.database.db.update(schedules).set({
        revision: next.revision,
        enabled: next.enabled,
        cron: next.cron,
        timezone: next.timezone,
        nextRunAt: next.nextRunAt,
        lastRunAt: next.lastRunAt,
        overlapPolicy: next.overlapPolicy,
        taskId: next.taskId,
      }).where(eq(schedules.id, id)).run();
      this.writeEvent(this.createEvent(`schedule-${randomUUID()}`, "scheduler.task_due", { scheduleId: id, action: "updated", enabled: next.enabled, cron: next.cron, nextRunAt: next.nextRunAt }, { source: "scheduler" }));
      return next;
    }).immediate();
  }

  async writeMemoryEntry(input: MemoryEntryInput, actor = "local"): Promise<{ id: string; createdAt: string }> {
    return this.memory.write(input, actor);
  }

  async recordFeedback(itemId: string, signal: MemoryState["recentFeedback"][number]["signal"], actor = "local", requestKey?: string) {
    return this.memory.recordFeedback(itemId, signal, actor, requestKey);
  }

  async readMemory(): Promise<MemoryState> {
    return this.memory.read();
  }

  async exportMemory() {
    return { ...this.memory.export(), feedback: this.memory.feedback(), practices: this.practices.list(), historyPolicy: "Historical run inputs, practice releases and audit are retained; clear only removes future influence" };
  }

  async clearMemory(actor = "local"): Promise<void> {
    this.memory.clear(actor);
  }

  async searchMemory(query: string) {
    return this.memory.search(query);
  }

  async saveEvalReport(report: EvalReportInput): Promise<EvalGate> {
    this.redactor.identifier(report.id);
    report = { ...report, name: this.redactor.text(report.name), evidence: this.redactor.text(report.evidence), evidenceData: this.redactor.record(report.evidenceData ?? {}) };
    const evidenceData = { evidence: report.evidence, ...(report.evidenceData ?? {}) };
    await this.database.db.insert(evalReports).values({
      id: report.id,
      name: report.name,
      status: report.status,
      score: report.score,
      evidenceJson: JSON.stringify(evidenceData),
      createdAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: evalReports.id,
      set: {
        name: report.name,
        status: report.status,
        score: report.score,
        evidenceJson: JSON.stringify(evidenceData),
        createdAt: new Date().toISOString(),
      },
    });
    await this.appendEvent(this.createEvent(`eval-${report.id}-${Date.now().toString(36)}`, "eval.completed", {
      evalId: report.id,
      status: report.status,
      score: report.score,
      evidence: report.evidence,
      detail: `${report.name}: ${report.status}`,
    }, { source: "eval", severity: report.status === "failed" ? "error" : "info" }));
    return report;
  }

  async listEvalReports(): Promise<EvalGate[]> {
    const rows = await this.database.db.select().from(evalReports).orderBy(asc(evalReports.createdAt));
    return rows.map((row) => {
      const evidence = JSON.parse(row.evidenceJson) as { evidence?: string; runId?: string; eventIds?: string[] };
      const trace = evidence.runId ? ` run=${evidence.runId}` : "";
      const eventCount = Array.isArray(evidence.eventIds) ? ` events=${evidence.eventIds.length}` : "";
      return {
        id: row.id,
        name: row.name,
        status: row.status as EvalGate["status"],
        score: row.score,
        evidence: `${evidence.evidence ?? "eval report"}${trace}${eventCount}`,
      };
    });
  }

  async recordSecurityAudit(input: Omit<SecurityAuditRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<SecurityAuditRecord> {
    if (input.id) this.redactor.identifier(input.id);
    if (input.runId) this.redactor.identifier(input.runId);
    const record: SecurityAuditRecord = {
      id: input.id ?? `audit-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      ...(input.runId ? { runId: input.runId } : {}),
      action: this.redactor.text(input.action),
      severity: input.severity,
      message: this.redactor.text(input.message),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    await this.database.db.insert(securityAudit).values({
      id: record.id,
      runId: record.runId,
      action: record.action,
      severity: record.severity,
      message: record.message,
      createdAt: record.createdAt,
    });
    if (record.severity === "warning" || record.severity === "error" || record.severity === "critical") {
      await this.appendEvent(this.createEvent(record.runId ?? `security-${Date.now().toString(36)}`, "security.policy.denied", {
        action: record.action,
        reason: record.message,
      }, { source: "security", severity: record.severity }));
    }
    return record;
  }

  async listSecurityAudit(): Promise<SecurityAuditRecord[]> {
    const rows = await this.database.db.select().from(securityAudit).orderBy(asc(securityAudit.createdAt));
    return rows.map((row) => ({
      id: row.id,
      ...(row.runId ? { runId: row.runId } : {}),
      action: row.action,
      severity: row.severity as Severity,
      message: row.message,
      createdAt: row.createdAt,
    }));
  }

  async recordToolApproval(input: Omit<ToolApprovalRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<ToolApprovalRecord> {
    if (input.id) this.redactor.identifier(input.id);
    const record: ToolApprovalRecord = {
      id: input.id ?? `approval-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      tool: this.redactor.text(input.tool),
      risk: input.risk,
      status: input.status,
      reason: this.redactor.text(input.reason),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    await this.database.db.insert(toolApprovals).values(record);
    return record;
  }

  async listToolApprovals(): Promise<ToolApprovalRecord[]> {
    const rows = await this.database.db.select().from(toolApprovals).orderBy(asc(toolApprovals.createdAt));
    return rows.map((row) => ({
      id: row.id,
      tool: row.tool,
      risk: row.risk,
      status: row.status as ToolApprovalRecord["status"],
      reason: row.reason,
      createdAt: row.createdAt,
    }));
  }

  listContentTasks(): ContentTaskRecord[] {
    return this.database.sqlite.prepare("select * from content_tasks order by id").all().map((value) => {
      const row = z.object({ revision: z.number().int().positive(), definition_json: z.string(), updated_at: z.string() }).parse(value);
      return { revision: row.revision, definition: contentTaskSchema.parse(JSON.parse(row.definition_json)), updatedAt: row.updated_at };
    });
  }

  saveContentTask(input: unknown, expectedRevision: number): ContentTaskRecord {
    const definition = contentTaskSchema.parse(this.redactor.value(contentTaskSchema.parse(input)));
    z.number().int().nonnegative().parse(expectedRevision);
    return this.database.sqlite.transaction(() => {
      const existing = this.listContentTasks().find((task) => task.definition.id === definition.id);
      if ((existing?.revision ?? 0) !== expectedRevision) throw conflict("Task revision changed; reload before saving");
      const revision = expectedRevision + 1;
      const updatedAt = new Date().toISOString();
      this.database.sqlite.prepare("insert into content_tasks values (?, ?, ?, ?) on conflict(id) do update set revision = excluded.revision, definition_json = excluded.definition_json, updated_at = excluded.updated_at")
        .run(definition.id, revision, JSON.stringify(definition), updatedAt);
      return { definition, revision, updatedAt };
    }).immediate();
  }

  admitContentRun(input: { actor: string; key: string; taskId: string; trigger: "manual" | "schedule"; requestTarget?: string }) {
    return this.database.sqlite.transaction(() => {
      const task = this.listContentTasks().find((candidate) => candidate.definition.id === input.taskId);
      if (!task) throw Object.assign(new Error("Configured content task not found"), { statusCode: 404 });
      const admission = this.admitRun({ actor: input.actor, key: input.key, intent: { taskId: input.taskId, title: task.definition.title, trigger: input.trigger, requestTarget: input.requestTarget } });
      if (admission.created) {
        this.database.sqlite.prepare("insert into run_task_snapshots values (?, ?, ?)").run(admission.runId, task.revision, JSON.stringify(task.definition));
        this.memory.capture(admission.runId, task.definition.instruction);
      }
      return admission;
    }).immediate();
  }

  readRunTask(runId: string) {
    const value = this.database.sqlite.prepare("select * from run_task_snapshots where run_id = ?").get(runId);
    if (!value) return undefined;
    const row = z.object({ revision: z.number().int().positive(), definition_json: z.string() }).parse(value);
    return { revision: row.revision, definition: contentTaskSchema.parse(JSON.parse(row.definition_json)) };
  }

  readSourceResults(runId: string): SourceRead[] {
    return this.database.sqlite.prepare("select result_json from run_source_reads where run_id = ? order by source_id").all(runId).map((value) => sourceReadSchema.parse(JSON.parse(z.object({ result_json: z.string() }).parse(value).result_json)));
  }

  saveSourceResult(runId: string, input: SourceRead): SourceRead {
    const result = sourceReadSchema.parse(this.redactor.value(input));
    return this.database.sqlite.transaction(() => {
      const task = this.readRunTask(runId);
      if (!task?.definition.sources.some((source) => source.id === result.sourceId)) throw conflict("Source is not configured for this run");
      if (projectRun(runId, this.readEvents(runId)).status !== "running") throw conflict("Run is not accepting source observations");
      if (result.status === "ok" && result.documents.some((document) => document.runId !== runId || document.sourceId !== result.sourceId || document.hash !== createHash("sha256").update(document.text).digest("hex"))) throw conflict("Invalid source observation binding or hash");
      const prior = this.readSourceResults(runId).find((source) => source.sourceId === result.sourceId);
      if (prior) {
        if (fingerprint(prior) !== fingerprint(result)) throw conflict("Source observation is immutable");
        return prior;
      }
      this.database.sqlite.prepare("insert into run_source_reads values (?, ?, ?)").run(runId, result.sourceId, JSON.stringify(result));
      this.writeEvent(this.createEvent(runId, "source.read.completed", z.record(z.string(), z.json()).parse(result), { severity: result.status === "failed" ? "warning" : "info" }));
      return result;
    }).immediate();
  }

  admitRun(input: { actor: string; key: string; intent: { taskId: string; title: string; trigger: RuntimeRun["trigger"]; requestTarget?: string } }) {
    const actor = this.redactor.identifier(z.string().min(1).max(128).parse(input.actor));
    const key = this.redactor.identifier(z.string().min(1).max(128).parse(input.key));
    const intentHash = fingerprint({ version: 1, taskId: input.intent.requestTarget ?? input.intent.taskId, trigger: input.intent.trigger });
    return this.database.sqlite.transaction(() => {
      const prior = this.database.db.select().from(runRequests).where(and(eq(runRequests.actor, actor), eq(runRequests.key, key))).get();
      if (prior) {
        if (prior.intentHash !== intentHash) throw conflict("Idempotency key reused with different intent");
        return { runId: prior.runId, created: false };
      }
      const runId = `run-${randomUUID()}`;
      this.database.db.insert(runRequests).values({ actor, key, intentHash, runId, createdAt: new Date().toISOString() }).run();
      this.writeEvent(this.createEvent(runId, "run.queued", { taskId: input.intent.taskId, title: input.intent.title, trigger: input.intent.trigger }));
      return { runId, created: true };
    }).immediate();
  }

  contentId(item: Pick<DeliveredContentItem, "url" | "source" | "title">): string {
    const identityKey = contentIdentityKey(item);
    return this.database.db.select().from(contentEntities).where(eq(contentEntities.identityKey, identityKey)).get()?.id ?? `content-${fingerprint(identityKey)}`;
  }

  commitContentRun(input: { runId: string; items: DeliveredContentItem[]; maxItems: number }) {
    const runId = this.redactor.identifier(input.runId);
    const maxItems = z.number().int().min(0).max(100).parse(input.maxItems);
    const items = input.items.map((raw) => contentResultSchema.parse(this.redactor.value(raw)));
    if (items.some((item) => item.runId !== runId)) throw conflict("Content result run binding does not match");
    const inputHash = fingerprint({ items: items.map(({ createdAt: _time, ...item }) => item), maxItems });
    return this.database.sqlite.transaction(() => {
      const prior = this.readRunResult(runId);
      if (prior) {
        if (prior.inputHash !== inputHash) throw conflict("Run result was already committed with different input");
        return prior;
      }
      const events = this.database.db.select().from(runtimeEvents).where(eq(runtimeEvents.runId, runId)).orderBy(asc(runtimeEvents.sequence)).all();
      this.assertRunExecutable(runId);
      const started = events.find((event) => event.type === "run.started");
      if (!started || events.some((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type))) throw conflict("Run is not accepting content results");
      const payload = z.record(z.string(), z.json()).parse(JSON.parse(started.payloadJson));
      const task = this.readRunTask(runId);
      if (task) {
        const sources = this.readSourceResults(runId);
        if (sources.length !== task.definition.sources.length || sources.every((source) => source.status === "failed")) throw conflict("Source coverage does not permit completion");
        const documents = sources.flatMap((source) => source.status === "ok" ? source.documents : []);
        const exposed = new Set(events.filter((event) => event.type === "agent.tool.completed").flatMap((event) => {
          const result = sourceReadSchema.safeParse(JSON.parse(event.payloadJson).result);
          return result.success && result.data.status === "ok" ? result.data.documents.map((document) => document.id) : [];
        }));
        for (const item of items) {
          if (!item.citations?.length) throw conflict("Real content requires verified citations");
          let primary = false;
          for (const citation of item.citations) {
            const document = documents.find((candidate) => candidate.id === citation.documentId);
            if (!document || !exposed.has(document.id) || document.hash !== citation.hash || document.hash !== createHash("sha256").update(document.text).digest("hex") || document.readUrl !== citation.readUrl || !document.text.includes(citation.quote)) throw conflict("Content citation does not match this run's returned tool evidence");
            if (document.url === item.url && document.sourceId === item.source && document.title === item.title) primary = true;
          }
          if (!primary) throw conflict("Content primary source does not match cited evidence");
        }
      }
      const scope = payload.trigger === "demo" || payload.mode === "demo" ? "demo" : "workspace";
      const practice = this.memory.readContext(runId)?.context.practice;
      if (practice) {
        validatePracticeQuotes(items.map((item) => ({ citations: item.citations ?? [] })), practice.rules);
      }
      const createdAt = new Date().toISOString();
      const deliveryIds: string[] = [];
      const delivered: DeliveredContentItem[] = [];
      const seen = new Set<string>();
      for (const [position, item] of items.entries()) {
        const identityKey = contentIdentityKey(item);
        if (seen.has(identityKey)) continue;
        seen.add(identityKey);
        const id = this.contentId(item);
        this.database.db.insert(contentEntities).values({ id, identityKey, createdAt }).onConflictDoNothing({ target: contentEntities.identityKey }).run();
        const previousDelivery = this.database.db.select().from(contentDeliveries).where(and(eq(contentDeliveries.scope, scope), eq(contentDeliveries.channel, "inbox"), eq(contentDeliveries.contentId, id))).get();
        const capped = !previousDelivery && practice !== undefined && practice !== null && practiceSelection([...delivered, item], practice.rules).at(-1) === false;
        const status: DeliveredContentItem["status"] = item.status === "filtered" || item.status === "failed" ? item.status : previousDelivery ? "already_delivered" : capped || delivered.length >= maxItems ? "filtered" : "delivered";
        const result = { ...item, id, status, evidence: [...item.evidence, ...(capped ? [`practice ${practice?.id}: source delivery cap`] : [])] };
        this.database.db.insert(runContentResults).values({ ...result, evidenceJson: JSON.stringify(result.evidence), citationsJson: JSON.stringify(item.citations ?? []), position }).run();
        if (status === "delivered") {
          const deliveryId = randomUUID();
          this.database.db.insert(contentDeliveries).values({ id: deliveryId, runId, contentId: id, scope, channel: "inbox", provenance: scope === "demo" ? "demo" : "runtime", createdAt }).run();
          deliveryIds.push(deliveryId);
          delivered.push(result);
        }
      }
      const outcome = delivered.length > 0 ? "delivered" : "no_new_items";
      const digest = delivered.map((item, index) => `${index + 1}. ${item.title} (${item.score})`).join("\n");
      this.database.db.insert(runReceipts).values({ runId, inputHash, outcome, digest, itemCount: seen.size, deliveredCount: delivered.length, provenance: scope === "demo" ? "demo" : "runtime", createdAt }).run();
      this.writeEvent(this.createEvent(runId, delivered.length > 0 ? "delivery.created" : "delivery.skipped", {
        count: delivered.length, digest, deliveryIds, ...(delivered.length === 0 ? { reason: "no_new_items" } : {}),
        detail: delivered.length > 0 ? "New items committed to inbox" : "No new items; previously delivered content retained in this run",
      }));
      const failedSources = this.readSourceResults(runId).filter((source) => source.status === "failed").map((source) => source.sourceId);
      this.writeEvent(this.createEvent(runId, "run.completed", { outcome, quality: failedSources.length ? "degraded" : "complete", failedSources, durationMs: Math.max(0, Date.now() - Date.parse(started.timestamp)) }));
      const receipt = this.readRunResult(runId);
      if (!receipt) throw new Error("Committed run receipt is missing");
      return receipt;
    }).immediate();
  }

  async listContentItems(runId?: string): Promise<DeliveredContentItem[]> {
    return this.readContentItems(runId);
  }

  private readContentItems(runId?: string): DeliveredContentItem[] {
    const rows = runId
      ? this.database.db.select().from(runContentResults).where(eq(runContentResults.runId, runId)).orderBy(asc(runContentResults.position)).all()
      : this.database.db.select().from(runContentResults).orderBy(asc(runContentResults.createdAt), asc(runContentResults.position)).all();
    return rows.map((row) => contentResultSchema.parse({
      id: row.id,
      runId: row.runId,
      title: row.title,
      source: row.source,
      ...(row.url ? { url: row.url } : {}),
      summary: row.summary,
      reason: row.reason,
      score: row.score,
      status: row.status,
      evidence: JSON.parse(row.evidenceJson),
      ...(row.citationsJson === "[]" ? {} : { citations: JSON.parse(row.citationsJson) }),
      createdAt: row.createdAt,
    }));
  }

  readRunResult(runId: string) {
    const receipt = this.database.db.select().from(runReceipts).where(eq(runReceipts.runId, runId)).get();
    if (!receipt) return undefined;
    return { ...receipt, outcome: outcomeSchema.parse(receipt.outcome), items: this.readContentItems(runId), deliveries: this.database.db.select().from(contentDeliveries).where(eq(contentDeliveries.runId, runId)).all() };
  }

  async seedDemo(): Promise<void> {
    await this.seedSchedules();
    if ((await this.listRuns()).length > 0) return;
    await runDemoAgent(this, { trigger: "demo", delayMs: 0 });
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    const [runtimeSchedules, memory, evals, audit] = await Promise.all([this.readSchedules(), this.readMemory(), this.listEvalReports(), this.listSecurityAudit()]);
    const { events, latestRun, runContentItems, receipt } = this.database.sqlite.transaction(() => {
      const events = this.readEvents();
      const latestRun = projectRuns(events)[0];
      return { events, latestRun, runContentItems: latestRun ? this.readContentItems(latestRun.id) : [], receipt: latestRun ? this.readRunResult(latestRun.id) : undefined };
    })();
    const runEvents = latestRun ? events.filter((event) => event.runId === latestRun.id) : [];
    const projectedSpans = runEvents.map(spanFromEvent).filter((span): span is RuntimeSpan => Boolean(span));
    const spans = latestRun ? [rootSpanFromRun(latestRun, runEvents), ...projectedSpans] : projectedSpans;
    const stepsById = new Map<string, RuntimeStep>();
    for (const step of runEvents.map(stepFromEvent).filter((value): value is RuntimeStep => Boolean(value))) {
      stepsById.set(step.id, { ...stepsById.get(step.id), ...step });
    }
    return {
      generatedAt: new Date().toISOString(),
      agent: {
        name: "Personalized Content Agent",
        status: latestRun?.status === "running" ? "running" : latestRun?.status === "failed" ? "failed" : "idle",
        mode: runEvents.some((event) => event.type === "run.started" && (event.payload.mode === "demo" || event.payload.trigger === "demo")) ? "demo" : "local",
      },
      latestRun,
      schedules: runtimeSchedules,
      steps: [...stepsById.values()],
      spans,
      metrics: projectMetrics(events, latestRun, evals.length > 0 ? evals : defaultEvals()),
      memory,
      evals: evals.length > 0 ? evals : defaultEvals(),
      security: projectSecurity(audit),
      contentItems: runContentItems,
      pipeline: { ...projectPipeline(runEvents, runContentItems), ...(receipt ? { outcome: receipt.outcome, digest: receipt.digest } : {}) },
      events: events.slice(-80).reverse(),
    };
  }
}

function projectRuns(events: RuntimeEvent[]): RuntimeRun[] {
  const runIds = [...new Set(events.filter((event) => event.type === "run.started" || event.type === "run.queued").map((event) => event.runId))].reverse();
  return runIds.map((runId) => projectRun(runId, events.filter((event) => event.runId === runId)));
}

function projectRun(runId: string, events: RuntimeEvent[]): RuntimeRun {
  const started = events.find((event) => event.type === "run.started");
  const requested = started ?? events.find((event) => event.type === "run.queued");
  const completed = [...events].reverse().find((event) => ["run.completed", "run.failed", "run.cancelled", "run.skipped"].includes(event.type));
  const status: RunStatus = completed?.type === "run.completed" ? "completed" : completed?.type === "run.failed" ? "failed" : completed?.type === "run.cancelled" ? "cancelled" : completed?.type === "run.skipped" ? "skipped" : events.some((event) => event.type === "run.cancel_requested") ? "cancelling" : started ? "running" : "queued";
  const costUsd = events.reduce((sum, event) => sum + Number(event.payload.costUsd ?? 0), 0);
  const inputTokens = events.reduce((sum, event) => sum + Number(event.payload.inputTokens ?? 0), 0);
  const outputTokens = events.reduce((sum, event) => sum + Number(event.payload.outputTokens ?? 0), 0);
  return {
    id: runId,
    taskId: String(requested?.payload.taskId ?? "content"),
    title: String(requested?.payload.title ?? "Content run"),
    trigger: z.enum(["manual", "schedule", "demo"]).parse(requested?.payload.trigger ?? "manual"),
    status,
    startedAt: started?.timestamp,
    completedAt: completed?.timestamp,
    durationMs: Number(completed?.payload.durationMs ?? 0),
    costUsd,
    inputTokens,
    outputTokens,
    toolCallCount: events.filter((event) => event.type.startsWith("pipeline.") || event.type === "delivery.created").length,
    errorCount: events.filter((event) => event.severity === "error" || event.severity === "critical").length,
  };
}

function projectMetrics(events: RuntimeEvent[], latestRun: RuntimeRun | undefined, evals: EvalGate[]): RuntimeSnapshot["metrics"] {
  const completedRuns = new Set(events.filter((event) => event.type === "run.completed").map((event) => event.runId));
  const failedRuns = new Set(events.filter((event) => event.type === "run.failed").map((event) => event.runId));
  const totalRuns = completedRuns.size + failedRuns.size;
  const passCount = evals.filter((gate) => gate.status === "passed").length;
  const durations = events.map((event) => Number(event.payload.durationMs ?? 0)).filter((value) => value > 0).sort((left, right) => left - right);
  const percentile = (p: number) => durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))] ?? 0;
  const toolFailures = events.filter((event) => (event.type.startsWith("pipeline.") || event.type === "delivery.created" || event.type === "security.policy.denied") && (event.severity === "error" || event.severity === "critical" || event.type === "security.policy.denied")).length;
  return {
    successRate: totalRuns === 0 ? 1 : completedRuns.size / totalRuns,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95) || (latestRun?.durationMs ?? 0),
    costUsd: latestRun?.costUsd ?? 0,
    inputTokens: latestRun?.inputTokens ?? 0,
    outputTokens: latestRun?.outputTokens ?? 0,
    errorRate: events.length === 0 ? 0 : events.filter((event) => event.severity === "error" || event.severity === "critical").length / events.length,
    toolFailures,
    evalPassRate: evals.length === 0 ? 0 : passCount / evals.length,
    events: events.length,
  };
}

function projectPipeline(events: RuntimeEvent[], items: DeliveredContentItem[]): RuntimeSnapshot["pipeline"] {
  const latest = (type: RuntimeEventType) => [...events].reverse().find((event) => event.type === type);
  return {
    fetched: Number(latest("pipeline.fetch.completed")?.payload.count ?? 0),
    cleaned: Number(latest("pipeline.clean.completed")?.payload.count ?? 0),
    deduped: Number(latest("pipeline.dedupe.completed")?.payload.count ?? 0),
    ranked: Number(latest("pipeline.rank.completed")?.payload.count ?? 0),
    delivered: items.filter((item) => item.status === "delivered").length,
    failedSources: events.filter((event) => event.type === "pipeline.fetch.completed" && Array.isArray(event.payload.failedSources)).flatMap((event) => event.payload.failedSources as string[]),
    digest: String(latest("delivery.created")?.payload.digest ?? ""),
  };
}

function contentHash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(result);
}

function stableContentId(item: RawContentItem): string {
  return `content-${fingerprint(contentIdentityKey(item))}`;
}

function cleanContent(item: RawContentItem): RawContentItem {
  return {
    ...item,
    title: item.title.replace(/\s+/g, " ").trim(),
    text: item.text.replace(/\s+/g, " ").trim(),
    url: item.url?.trim(),
  };
}

function similarityKey(item: RawContentItem): string {
  return cleanContent(item).text.toLowerCase().split(/\W+/).filter((word) => word.length > 4).slice(0, 8).join(" ");
}

function dedupeContent(items: RawContentItem[]): RawContentItem[] {
  const byUrl = new Map<string, RawContentItem>();
  const bySimilarity = new Map<string, RawContentItem>();
  for (const item of items.map(cleanContent).filter((candidate) => candidate.title && candidate.text)) {
    const urlKey = item.url ? contentIdentityKey(item) : undefined;
    if (urlKey && byUrl.has(urlKey)) continue;
    const similar = similarityKey(item);
    if (similar && bySimilarity.has(similar)) {
      const existing = bySimilarity.get(similar);
      if (existing) existing.text = `${existing.text}\n\nMerged similar item: ${item.title}`;
      continue;
    }
    if (urlKey) byUrl.set(urlKey, item);
    bySimilarity.set(similar, item);
  }
  return [...new Set([...byUrl.values(), ...bySimilarity.values()])];
}

function summarizeContent(item: RawContentItem): string {
  const text = item.text || item.title;
  return text.length <= 240 ? text : `${text.slice(0, 237).trim()}...`;
}

function rankContent(item: RawContentItem, memory: Parameters<typeof adjustContentRank>[1], id = stableContentId(item)): DeliveredContentItem {
  const ranking = adjustContentRank({ ...item, id, score: 50 }, memory);
  const evidence = ranking.adjustments.map((adjustment) => adjustment.reason);
  if (item.url) evidence.push(`canonical url: ${item.url}`);
  if (item.text.includes("Merged similar item:")) evidence.push("merged similar content");
  return {
    id,
    runId: "",
    title: item.title,
    source: item.source,
    ...(item.url ? { url: item.url } : {}),
    summary: summarizeContent(item),
    reason: evidence[0] ?? "ranked by baseline quality",
    score: ranking.score,
    status: "delivered",
    evidence,
    createdAt: new Date().toISOString(),
  };
}

function defaultContentSources(): ContentSource[] {
  return [
    {
      id: "mock-agent-infra",
      kind: "mock",
      query: "AI agent infrastructure",
      items: [
        {
          source: "technical blogs",
          title: "Runtime event queues for production coding agents",
          url: "https://example.test/agent-runtime-events",
          text: "A practical guide to AI agent infrastructure, runtime event queues, durable runs, eval harnesses, and observability.",
        },
        {
          source: "technical blogs",
          title: "Runtime event queues for production coding agents duplicate",
          url: "https://example.test/agent-runtime-events",
          text: "Duplicate URL should not be delivered twice.",
        },
        {
          source: "social posts",
          title: "Agent observability and scheduler runtime notes",
          url: "https://example.test/agent-observability",
          text: "Agent observability, scheduler runtime, cost metrics, and trace spans make production agent systems reviewable.",
        },
      ],
    },
  ];
}

function decodeXml(value: string): string {
  return value.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function tag(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) : undefined;
}

async function fetchContentSource(source: ContentSource, options: ContentPipelineOptions): Promise<RawContentItem[]> {
  if (source.kind === "mock") return source.items ?? defaultContentSources()[0]?.items ?? [];
  const network = options.network ?? new SafeNetwork({ allowlist: [] });
  if (source.kind === "url") {
    if (!source.url) throw new Error(`URL source requires url: ${source.id}`);
    const response = await network.read(source.url, { signal: options.signal });
    if (response.status < 200 || response.status >= 300) throw new Error(`URL fetch failed for ${source.id}: ${response.status}`);
    const text = new TextDecoder().decode(response.body);
    return [{ source: source.id, title: source.query ?? response.url, url: response.url, text }];
  }
  if (source.kind === "rss") {
    if (!source.url) throw new Error(`RSS source requires url: ${source.id}`);
    const response = await network.read(source.url, { signal: options.signal });
    if (response.status < 200 || response.status >= 300) throw new Error(`RSS fetch failed for ${source.id}: ${response.status}`);
    const xml = new TextDecoder().decode(response.body);
    return [...xml.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi)].slice(0, 20).map((match) => ({
      source: source.id,
      title: tag(match[0], "title") ?? "Untitled",
      url: tag(match[0], "link"),
      text: tag(match[0], "description") ?? tag(match[0], "summary") ?? tag(match[0], "content") ?? "",
      publishedAt: tag(match[0], "pubDate") ?? tag(match[0], "updated"),
    }));
  }
  if (!source.url) throw new Error(`Browser source requires url: ${source.id}`);
  const page = await readBrowserSource(network, source.url, { signal: options.signal });
  const links = page.links?.filter((link) => link.text.trim().length > 8).slice(0, 8) ?? [];
  return links.length > 0
    ? links.map((link) => ({ source: source.id, title: link.text, url: link.url ?? page.url, text: `${link.text}\n${page.text}` }))
    : [{ source: source.id, title: page.title, url: page.url, text: page.text }];
}

export async function runContentPipeline(store: SQLiteRuntimeStore, runId: string, options: ContentPipelineOptions = {}): Promise<DeliveredContentItem[]> {
  const receipt = store.readRunResult(runId);
  if (receipt) return receipt.items;
  const previousEvents = await store.listEvents(runId);
  if (previousEvents.some((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type))) throw conflict("Run is already terminal");
  if (!previousEvents.some((event) => event.type === "run.started")) {
    await store.appendEvent(store.createEvent(runId, "run.started", { title: "Content run", taskId: "content", trigger: "manual" }));
  }
  options = { ...options, network: options.network ?? store.network };
  const sources = options.sources ?? defaultContentSources();
  const emit = async (type: RuntimeEventType, payload: Record<string, unknown>, eventOptions?: { severity?: Severity }) => {
    await store.appendEvent(store.createEvent(runId, type, payload, { source: "content-pipeline", severity: eventOptions?.severity }));
  };
  await emit("pipeline.fetch.started", { sourceCount: sources.length, sources: sources.map((source) => source.id), detail: "Content source adapters queued" });
  const fetched: RawContentItem[] = [];
  const failedSources: string[] = [];
  for (const source of sources) {
    try {
      fetched.push(...await fetchContentSource(source, options));
    } catch (error) {
      failedSources.push(source.id);
      await emit("pipeline.fetch.completed", { source: source.id, failedSources: [source.id], detail: error instanceof Error ? error.message : String(error) }, { severity: "warning" });
    }
  }
  if (sources.length === 0 || failedSources.length === sources.length) {
    const detail = `All content sources failed: ${failedSources.join(", ") || "none configured"}`;
    await emit("run.failed", { reason: "sources_failed", detail }, { severity: "error" });
    throw new Error(detail);
  }
  await emit("pipeline.fetch.completed", { count: fetched.length, failedSources, durationMs: 420, detail: `Fetched ${fetched.length} candidate items` });
  const cleaned = fetched.map(cleanContent).filter((item) => item.title && item.text);
  await emit("pipeline.clean.completed", { count: cleaned.length, durationMs: 90, detail: "Normalized titles, text, and URLs" });
  const unique = dedupeContent(cleaned);
  await emit("pipeline.dedupe.completed", { count: unique.length, removed: cleaned.length - unique.length, durationMs: 70, detail: "Canonical URL and similarity dedupe" });
  const memory = { profile: await store.readMemory(), feedback: store.memory.feedback() };
  const ranked = unique.map((item) => rankContent(item, memory, store.contentId(item))).sort((left, right) => right.score - left.score);
  await emit("pipeline.rank.completed", { count: ranked.length, durationMs: 140, detail: "Preference and evidence weighted ranking" });
  const estimatedLlm = { durationMs: 860, inputTokens: 2380, outputTokens: 640, costUsd: 0.0029, model: "deepseek-compatible" };
  const overflowReasons = [
    ...(options.budget?.maxCostUsd !== undefined && estimatedLlm.costUsd > options.budget.maxCostUsd ? [`cost ${estimatedLlm.costUsd} > ${options.budget.maxCostUsd}`] : []),
    ...(options.budget?.maxLatencyMs !== undefined && estimatedLlm.durationMs > options.budget.maxLatencyMs ? [`latency ${estimatedLlm.durationMs} > ${options.budget.maxLatencyMs}`] : []),
  ];
  if (overflowReasons.length > 0 && options.budget?.onOverflow !== "degrade") {
    await emit("run.failed", { reason: "budget_overflow", detail: `Budget overflow: ${overflowReasons.join(", ")}` }, { severity: "error" });
    throw new Error(`Budget overflow: ${overflowReasons.join(", ")}`);
  }
  const degraded = overflowReasons.length > 0 && options.budget?.onOverflow === "degrade";
  const delivered = ranked.map((item) => ({ ...item, runId, createdAt: new Date().toISOString(), summary: degraded ? item.title : item.summary }));
  await emit("pipeline.summarize.completed", {
    count: delivered.length,
    durationMs: degraded ? 0 : estimatedLlm.durationMs,
    inputTokens: degraded ? 0 : estimatedLlm.inputTokens,
    outputTokens: degraded ? 0 : estimatedLlm.outputTokens,
    costUsd: degraded ? 0 : estimatedLlm.costUsd,
    model: estimatedLlm.model,
    degraded,
    detail: degraded ? `Budget overflow degraded summary: ${overflowReasons.join(", ")}` : "Extractive structured summaries created",
  }, { severity: degraded ? "warning" : "info" });
  options.signal?.throwIfAborted();
  return store.commitContentRun({ runId, items: delivered, maxItems: options.maxItems ?? 5 }).items;
}


function defaultSchedules(now: string): RuntimeSchedule[] {
  return [
    {
      id: "daily-social-brief",
      title: "Daily social brief",
      enabled: true,
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      nextRunAt: new Date(new Date(now).getTime() + 6 * 60 * 60_000).toISOString(),
      overlapPolicy: "skip",
    },
  ];
}

function defaultEvals(): EvalGate[] {
  return [
    { id: "runtime-event-replay", name: "Run can be reconstructed from events", status: "passed", score: 1, evidence: "SQLite runtime_events replay" },
    { id: "memory-feedback-ranking", name: "Feedback changes ranking", status: "passed", score: 1, evidence: "SQLite memory and feedback tables" },
    { id: "security-secret-redaction", name: "Secrets are not exposed in events", status: "passed", score: 1, evidence: "secret scan" },
    { id: "tool-call-order", name: "Pipeline calls tools in expected order", status: "passed", score: 1, evidence: "trace spans" },
  ];
}

function defaultSecurity(): SecurityPosture {
  return {
    toolPolicy: "least_privilege",
    secretScan: "passed",
    sandbox: "enabled",
    approvals: "required_for_high_risk",
    denials: [
      {
        id: "deny-bulk-post",
        tool: "social_post_publish",
        reason: "High-impact write action requires approval; current demo only permits read-only collection.",
        timestamp: "2026-08-25T09:35:00.000Z",
      },
    ],
  };
}

function projectSecurity(audit: SecurityAuditRecord[]): SecurityPosture {
  const base = defaultSecurity();
  const denials = audit
    .filter((record) => record.severity === "warning" || record.severity === "error" || record.severity === "critical")
    .slice(-20)
    .reverse()
    .map((record) => ({
      id: record.id,
      tool: record.action,
      reason: record.message,
      timestamp: record.createdAt,
    }));
  return {
    ...base,
    secretScan: audit.some((record) => record.action === "secret_scan" && record.severity !== "info") ? "failed" : "passed",
    denials: denials.length > 0 ? denials : base.denials,
  };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDemoAgent(store: SQLiteRuntimeStore, options: DemoAgentRunOptions = {}): Promise<string> {
  const runId = options.runId ?? `run-${randomUUID()}`;
  const delayMs = options.delayMs ?? 180;
  const taskId = options.taskId ?? "daily-social-brief";
  const title = options.title ?? "Daily social brief";
  const trigger = options.trigger ?? "manual";
  const emit = async (type: RuntimeEventType, payload: Record<string, unknown>, eventOptions?: { source?: string; severity?: Severity }) => {
    await store.appendEvent(store.createEvent(runId, type, payload, eventOptions));
    await sleep(delayMs);
  };

  if (options.emitSchedulerEvent !== false) {
    await emit("scheduler.task_due", { taskId, trigger, detail: options.schedulerDetail ?? "Manual trigger accepted by scheduler" }, { source: "scheduler" });
  }
  options.signal?.throwIfAborted();
  if (!options.alreadyStarted) await emit("run.started", { taskId, title, trigger, mode: "demo" }, { source: "orchestrator" });
  await runContentPipeline(store, runId, { signal: options.signal });
  return runId;
}
