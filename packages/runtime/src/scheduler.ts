import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import cron, { type ScheduledTask } from "node-cron";
import { z } from "zod";
import { createSqliteDatabase, type SqliteDatabase } from "@simple-coding-agent/db";
import { runDemoAgent, type SQLiteRuntimeStore, type RuntimeSchedule, type RuntimeEventType } from "./index.js";
import { coalesceDue } from "./schedule-time.js";

const jobSchema = z.object({
  seq: z.number().int(), run_id: z.string(), scope_key: z.string(), request_target: z.string(),
  schedule_id: z.string().nullable(), schedule_revision: z.number().nullable(),
  trigger: z.enum(["manual", "schedule", "demo"]), scheduled_for: z.string().nullable(), admitted_at: z.string(),
  started_at: z.string().nullable(), finished_at: z.string().nullable(),
  state: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled", "skipped"]), reason: z.string(),
});
type Job = z.infer<typeof jobSchema>;
type Identity = { actor: string; key: string };
const memoryOwners = new WeakSet<SqliteDatabase["sqlite"]>();
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

export type SchedulerRunResult =
  | { status: "started" | "queued"; scheduleId: string; runId: string; reason: string }
  | { status: "skipped"; scheduleId: string; runId: string; reason: "overlap_skip" };
export type RuntimeSchedulerOptions = {
  runtime: SQLiteRuntimeStore;
  runAgent?: (input: { runId: string; signal: AbortSignal }) => Promise<string>;
  now?: () => Date;
};

export class RuntimeScheduler {
  private lock: SqliteDatabase | undefined;
  private owned = false;
  private stopping = false;
  private timer: ScheduledTask | undefined;
  private active: { runId: string; controller: AbortController; completion: Promise<void> } | undefined;
  constructor(private readonly options: RuntimeSchedulerOptions) {}
  private get store() { return this.options.runtime; }
  private get sql() { return this.store.database.sqlite; }
  private now() { return this.options.now?.() ?? new Date(); }

  listJobs(): Job[] { return this.sql.prepare("select * from scheduled_jobs order by seq").all().map((row) => jobSchema.parse(row)); }
  private event(runId: string, type: RuntimeEventType, payload: Record<string, unknown>, now = this.now()) {
    return this.store.appendEventSync({ ...this.store.createEvent(runId, type, payload, { source: "scheduler", severity: type === "run.failed" ? "error" : type === "run.cancel_requested" ? "warning" : "info" }), timestamp: now.toISOString() });
  }

  private own(): void {
    if (this.stopping) throw conflict("Worker is stopping");
    if (this.owned) {
      if (this.lock && (!this.lock.sqlite.open || !this.lock.sqlite.inTransaction)) throw conflict("Worker ownership lock was lost");
      return;
    }
    if (this.sql.name === ":memory:" || this.sql.name === "") {
      if (memoryOwners.has(this.sql)) throw conflict("Another worker owns this workspace");
      memoryOwners.add(this.sql);
    } else {
      const lock = createSqliteDatabase(`${realpathSync(this.sql.name)}.worker-lock`);
      try {
        lock.sqlite.pragma("busy_timeout = 0");
        lock.sqlite.pragma("journal_mode = DELETE");
        lock.sqlite.exec("begin exclusive");
      } catch { lock.sqlite.close(); throw conflict("Another worker owns this workspace"); }
      this.lock = lock;
    }
    this.owned = true;
    try {
      this.sql.transaction(() => {
        const requests = this.sql.prepare(`select r.run_id from run_requests r where not exists (select 1 from scheduled_jobs j where j.run_id = r.run_id)
          order by (select min(sequence) from runtime_events e where e.run_id = r.run_id)`).all();
        for (const value of requests) {
          const { run_id: runId } = z.object({ run_id: z.string() }).parse(value);
          const detail = this.store.readRunDetail(runId);
          if (!detail) throw new Error("Legacy request has no run evidence");
          const triggerEvent = detail.events.find((event) => event.type === "scheduler.task_due" && typeof event.payload.scheduleId === "string");
          const scheduleId = typeof triggerEvent?.payload.scheduleId === "string" ? triggerEvent.payload.scheduleId : undefined;
          const schedule = this.store.readSchedulesSync().find((entry) => entry.id === scheduleId);
          const target = scheduleId ? `schedule:${scheduleId}` : detail.task ? `task:${detail.task.definition.id}` : "demo";
          const scope = detail.task ? `task:${detail.task.definition.id}` : target;
          this.insertJob(runId, scope, target, schedule, detail.run.trigger, "legacy_request");
          this.sql.prepare("update scheduled_jobs set state = ?, started_at = ?, finished_at = ? where run_id = ?").run(detail.run.status, detail.run.startedAt ?? null, detail.run.completedAt ?? null, runId);
          if (detail.run.status === "queued" && !detail.task) this.event(runId, "run.failed", { reason: "worker_interrupted_legacy", detail: "Legacy queued request has no frozen task" });
        }
        for (const job of this.listJobs()) {
          if (job.state === "running" || job.state === "cancelling") this.event(job.run_id, job.state === "cancelling" ? "run.cancelled" : "run.failed", { reason: job.state === "cancelling" ? job.reason : "worker_interrupted", detail: "Previous execution ended without a terminal commit; it was not retried" });
        }
        const legacy = this.sql.prepare(`select distinct run_id from runtime_events e where e.type in ('run.queued','run.started')
          and not exists (select 1 from scheduled_jobs j where j.run_id = e.run_id)
          and not exists (select 1 from runtime_events t where t.run_id = e.run_id and t.type in ('run.completed','run.failed','run.cancelled','run.skipped'))`).all();
        for (const row of legacy) {
          const { run_id: runId } = z.object({ run_id: z.string() }).parse(row);
          const detail = this.store.readRunDetail(runId);
          if (detail?.run.status === "queued" && detail.task) this.insertJob(runId, `task:${detail.task.definition.id}`, `task:${detail.task.definition.id}`, undefined, detail.run.trigger, "recovered_queue");
          else this.event(runId, "run.failed", { reason: "worker_interrupted_legacy", detail: "Legacy unfinished attempt cannot be safely resumed" });
        }
      }).immediate();
    } catch (error) { this.release(); throw error; }
  }

  start(): void {
    this.own();
    if (this.timer) return;
    this.timer = cron.schedule("* * * * * *", () => this.tick().catch((error) => {
      this.active?.controller.abort(error);
      process.stderr.write(`scheduler tick failed: ${this.store.redactor.text(error instanceof Error ? error.message : "unknown error")}\n`);
    }), { timezone: "UTC", noOverlap: true });
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.destroy(); this.timer = undefined;
    const active = this.active;
    if (active && this.sql.open) this.requestCancellation(active.runId, "server_shutdown", "worker");
    active?.controller.abort(new Error("Worker shutting down"));
    await active?.completion;
    this.release();
  }

  private release() {
    if (!this.owned) return;
    if (this.lock?.sqlite.open) {
      if (this.lock.sqlite.inTransaction) this.lock.sqlite.exec("rollback");
      this.lock.sqlite.close();
    }
    this.lock = undefined;
    memoryOwners.delete(this.sql); this.owned = false;
  }

  async tick(now: Date = this.now()): Promise<SchedulerRunResult[]> {
    this.own();
    const results = this.sql.transaction(() => {
      const admitted: SchedulerRunResult[] = [];
      for (const schedule of this.store.readSchedulesSync()) {
        if (!schedule.enabled || new Date(schedule.nextRunAt) > now) continue;
        const missed = coalesceDue(schedule, now);
        const key = createHash("sha256").update(JSON.stringify([schedule.id, schedule.revision, missed.first])).digest("hex");
        const job = this.admit({ actor: "scheduler", key }, `schedule:${schedule.id}`, schedule, undefined, "schedule", missed.first);
        this.sql.prepare("update schedules set next_run_at = ? where id = ?").run(missed.next, schedule.id);
        this.event(job.run_id, "scheduler.task_due", { scheduleId: schedule.id, scheduledFor: missed.first, missedThrough: missed.last, ...( "count" in missed ? { occurrenceCount: missed.count } : {}), coalesced: missed.first !== missed.last, nextRunAt: missed.next, reason: job.reason }, now);
        admitted.push(job.state === "skipped" ? { status: "skipped", scheduleId: schedule.id, runId: job.run_id, reason: "overlap_skip" } : { status: "queued", scheduleId: schedule.id, runId: job.run_id, reason: job.reason });
      }
      return admitted;
    }).immediate();
    this.applyCancellation(); this.pump();
    if (!this.options.runAgent) await this.idle();
    return results.map((result) => result.status === "queued" && this.job(result.runId).state !== "queued" ? { ...result, status: "started" } : result);
  }

  async runNow(scheduleId?: string, identity: Identity = { actor: "local", key: randomUUID() }): Promise<string> {
    return this.manual(identity, scheduleId ? `schedule:${scheduleId}` : "demo", scheduleId, undefined);
  }
  async runTask(taskId: string, identity: Identity): Promise<string> {
    return this.manual(identity, `task:${taskId}`, undefined, taskId);
  }
  private async manual(identity: Identity, target: string, scheduleId?: string, taskId?: string): Promise<string> {
    this.own();
    const job = this.sql.transaction(() => {
      const prior = this.prior(identity, target);
      if (prior) return prior;
      const schedule = scheduleId ? this.store.readSchedulesSync().find((entry) => entry.id === scheduleId) : undefined;
      if (scheduleId && !schedule) throw Object.assign(new Error("Schedule not found"), { statusCode: 404 });
      return this.admit(identity, target, schedule, taskId, "manual");
    }).immediate();
    if (job.state === "skipped") throw Object.assign(conflict("overlap_skip"), { runId: job.run_id });
    this.applyCancellation(); this.pump();
    if (!this.options.runAgent) await this.idle();
    return job.run_id;
  }

  private prior(identity: Identity, target: string): Job | undefined {
    const row = this.sql.prepare("select j.* from scheduled_jobs j join run_requests r on r.run_id = j.run_id where r.actor = ? and r.request_key = ?").get(identity.actor, identity.key);
    if (!row) return undefined;
    const job = jobSchema.parse(row);
    if (job.request_target !== target) throw conflict("Idempotency key reused with different intent");
    return job;
  }

  private admit(identity: Identity, target: string, schedule: RuntimeSchedule | undefined, taskId: string | undefined, trigger: "manual" | "schedule", scheduledFor?: string): Job {
    const prior = this.prior(identity, target);
    if (prior) return prior;
    taskId ??= schedule?.taskId;
    const scope = taskId ? `task:${taskId}` : schedule ? `schedule:${schedule.id}` : "demo";
    const admission = taskId ? this.store.admitContentRun({ ...identity, taskId, trigger, requestTarget: target }) : this.store.admitRun({ ...identity, intent: { taskId: schedule?.id ?? "manual-content", title: schedule?.title ?? "Content run", trigger, requestTarget: target } });
    const older = this.sql.prepare("select * from scheduled_jobs where scope_key = ? and state in ('queued','running','cancelling') order by seq").all(scope).map((row) => jobSchema.parse(row));
    const policy = schedule?.overlapPolicy ?? "queue";
    const reason = older.length ? policy === "skip" ? "overlap_skip" : policy === "cancel_previous" ? "cancel_previous" : "overlap_queue" : trigger === "manual" ? "manual" : "due";
    this.insertJob(admission.runId, scope, target, schedule, trigger, reason, scheduledFor);
    if (older.length && policy === "skip") this.event(admission.runId, "run.skipped", { reason });
    else if (older.length && policy === "cancel_previous") for (const job of older) this.requestCancellation(job.run_id, "cancel_previous", identity.actor);
    this.event(admission.runId, "scheduler.task_due", { ...(schedule ? { scheduleId: schedule.id } : {}), reason, trigger, ...(scheduledFor ? { scheduledFor } : {}) });
    return this.job(admission.runId);
  }

  private insertJob(runId: string, scope: string, target: string, schedule: RuntimeSchedule | undefined, trigger: Job["trigger"], reason: string, scheduledFor?: string) {
    this.sql.prepare(`insert into scheduled_jobs (run_id, scope_key, request_target, schedule_id, schedule_revision, trigger, scheduled_for, admitted_at, state, reason)
      values (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
      .run(runId, scope, target, schedule?.id ?? null, schedule?.revision ?? null, trigger, scheduledFor ?? null, this.now().toISOString(), reason);
  }
  private job(runId: string) { return jobSchema.parse(this.sql.prepare("select * from scheduled_jobs where run_id = ?").get(runId)); }

  cancel(runId: string, actor: string) {
    this.own();
    const state = this.sql.transaction(() => this.requestCancellation(runId, "user_request", actor)).immediate();
    this.applyCancellation(); this.pump();
    return { runId, status: state };
  }
  private requestCancellation(runId: string, reason: string, actor: string): Job["state"] {
    const value = this.sql.prepare("select * from scheduled_jobs where run_id = ?").get(runId);
    if (!value) throw Object.assign(new Error("Worker run not found"), { statusCode: 404 });
    const job = jobSchema.parse(value);
    if (job.state === "queued") this.event(runId, "run.cancelled", { reason, actor });
    else if (job.state === "running") this.event(runId, "run.cancel_requested", { reason, actor });
    return this.job(runId).state;
  }
  private applyCancellation() {
    if (this.active && this.job(this.active.runId).state === "cancelling") this.active.controller.abort(new Error("Run cancellation requested"));
  }

  private pump(): void {
    if (this.active || this.stopping) return;
    this.own();
    const job = this.sql.transaction(() => {
      const value = this.sql.prepare("select * from scheduled_jobs where state = 'queued' order by seq limit 1").get();
      if (!value) return undefined;
      const next = jobSchema.parse(value);
      const detail = this.store.readRunDetail(next.run_id);
      if (!detail) throw new Error("Queued run has no admission event");
      this.event(next.run_id, "run.started", { taskId: detail.run.taskId, title: detail.run.title, trigger: next.trigger, mode: detail.task ? "live" : "demo", ...(detail.task ? { taskRevision: detail.task.revision } : {}) });
      return next;
    }).immediate();
    if (!job) return;
    const controller = new AbortController();
    // Defer dispatch until active ownership is installed; completion always drains before the next job.
    const completion = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        if (this.options.runAgent) await this.options.runAgent({ runId: job.run_id, signal: controller.signal });
        else await runDemoAgent(this.store, { runId: job.run_id, trigger: job.trigger, delayMs: 0, alreadyStarted: true, signal: controller.signal, emitSchedulerEvent: false });
        const state = this.job(job.run_id).state;
        if (state === "cancelling") this.event(job.run_id, "run.cancelled", { reason: this.job(job.run_id).reason });
        else if (state === "running") this.event(job.run_id, "run.failed", { reason: "executor_missing_terminal", detail: "Executor returned without a terminal result" });
      } catch (error) {
        const state = this.job(job.run_id).state;
        if (state === "running" || state === "cancelling") this.event(job.run_id, state === "cancelling" ? "run.cancelled" : "run.failed", { reason: state === "cancelling" ? this.job(job.run_id).reason : "execution_failed", detail: error instanceof Error ? error.message : "Execution failed" });
      } finally { this.active = undefined; if (!this.stopping) this.pump(); }
    });
    this.active = { runId: job.run_id, controller, completion };
    void completion.catch((error) => { this.stopping = true; process.stderr.write(`Worker persistence failure: ${this.store.redactor.text(error instanceof Error ? error.message : "unknown")}\n`); });
  }

  async idle(): Promise<void> { while (this.active) await this.active.completion; }
}
