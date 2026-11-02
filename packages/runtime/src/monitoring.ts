import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SQLiteRuntimeStore } from "./index.js";

const interval = z.number().int().min(1).max(86_400_000);
export const monitoringPolicySchema = z.object({
  heartbeatMs: interval.default(30_000), staleMs: interval.default(90_000),
  pollMs: interval.default(5_000), overdueMs: interval.default(15_000),
  errorWindowMs: interval.default(300_000), errorThreshold: z.number().int().min(1).max(10_000).default(3),
}).strict().refine((p) => p.pollMs < p.overdueMs && p.overdueMs < p.staleMs && p.heartbeatMs < p.staleMs, "Invalid monitoring interval order");
type Policy = z.infer<typeof monitoringPolicySchema>;
export type WorkerPhase = "unowned" | "ready" | "faulted" | "draining" | "stopped";
type Freshness = "missing" | "fresh" | "stale" | "unknown";
type Condition = "heartbeat_stale" | "worker_fault" | "error_burst";
type Verdict = "active" | "inactive" | "unknown";
type OwnerState = { held: boolean; phase: WorkerPhase; activeRunId: string | null };
type OwnerBinding = { inspect(): OwnerState; fault(code: string): void };
export type MonitoringOptions = {
  policy?: Partial<Policy>;
  now?: () => Date;
  monotonic?: () => number;
  // An internal harness seam, never exposed through HTTP or model tools.
  repeat?: (kind: "heartbeat" | "monitor", callback: () => void, ms: number) => () => void;
};
export type WorkerHealth = {
  ready: boolean;
  database: "connected" | "unavailable";
  worker: { locallyOwned: boolean; session: string | null; phase: WorkerPhase; heartbeat: Freshness; lastHeartbeatAt: string | null; activeRunId: string | null };
  monitor: { freshness: Freshness; lastPolledAt: string | null };
  reasons: string[];
};
const sampleSchema = z.object({ session: z.string().uuid(), sequence: z.number().int().positive(), observed_at: z.iso.datetime(), payload_json: z.string() });
const payloadSchema = z.object({ phase: z.enum(["unowned", "ready", "faulted", "draining", "stopped"]), activeRunId: z.string().nullable() }).strict();
const transitionSchema = z.object({
  sequence: z.number().int().positive(), condition: z.enum(["heartbeat_stale", "worker_fault", "error_burst"]),
  generation: z.number().int().positive(), edge: z.enum(["open", "recovery"]), observed_at: z.iso.datetime(), evidence_json: z.string(),
});
const evidenceSchema = z.object({ ruleVersion: z.literal(1), session: z.string().uuid(), watermark: z.number().int().nonnegative(), failedRuns: z.number().int().nonnegative(), windowStart: z.iso.datetime(), heartbeat: z.enum(["missing", "fresh", "stale", "unknown"]), phase: z.enum(["unowned", "ready", "faulted", "draining", "stopped"]),
  source: z.enum(["worker", "runtime"]), severity: z.enum(["warning", "critical"]), runIds: z.array(z.string().min(1).max(256)).max(20), sampleTruncated: z.boolean(),
}).strict();

export function evaluateMonitorConditions(sample: { heartbeat: Freshness; phase: WorkerPhase; failedRuns: number | null; errorThreshold: number }): Record<Condition, Verdict> {
  return {
    heartbeat_stale: sample.heartbeat === "unknown" || sample.heartbeat === "missing" ? "unknown" : sample.heartbeat === "stale" ? "active" : "inactive",
    worker_fault: sample.phase === "faulted" ? "active" : sample.phase === "ready" && sample.heartbeat === "fresh" ? "inactive" : "unknown",
    error_burst: sample.failedRuns === null ? "unknown" : sample.failedRuns >= sample.errorThreshold ? "active" : "inactive",
  };
}

function repeat(_kind: "heartbeat" | "monitor", callback: () => void, ms: number): () => void {
  const timer = setInterval(callback, ms); timer.unref();
  return () => clearInterval(timer);
}

export class RuntimeMonitoring {
  readonly policy: Policy;
  private binding: (OwnerBinding & { session: string }) | undefined;
  private disposers: Array<() => void> = [];
  private heartbeatMono: number | undefined;
  private pollMono: number | undefined;
  private latestWall = -Infinity;
  private running = false;
  constructor(private readonly store: SQLiteRuntimeStore, private readonly options: MonitoringOptions = {}) {
    this.policy = monitoringPolicySchema.parse(options.policy ?? {});
  }
  private get sql() { return this.store.database.sqlite; }
  private now() { return this.options.now?.() ?? new Date(); }
  private monotonic() { return this.options.monotonic?.() ?? performance.now(); }

  bind(owner: OwnerBinding): void {
    if (this.binding) throw new Error("Monitoring already bound");
    if (!owner.inspect().held) throw new Error("Monitoring requires worker ownership");
    const binding = { ...owner, session: randomUUID() };
    this.binding = binding;
    try {
      this.sql.transaction(() => { this.write("worker", true); this.poll(true); }).immediate();
      this.running = true;
      const schedule = this.options.repeat ?? repeat;
      this.disposers.push(schedule("heartbeat", () => this.guarded(binding, "heartbeat_write_failed", () => this.write("worker")), this.policy.heartbeatMs));
      this.disposers.push(schedule("monitor", () => this.guarded(binding, "monitor_poll_failed", () => this.poll()), this.policy.pollMs));
    } catch (error) {
      for (const dispose of this.disposers.splice(0)) dispose();
      this.binding = undefined;
      this.running = false;
      throw error;
    }
  }

  private guarded(binding: OwnerBinding & { session: string }, code: string, action: () => void) {
    if (!this.running || this.binding !== binding) return;
    try {
      if (!binding.inspect().held) throw new Error("Worker ownership lost");
      action();
    } catch {
      binding.fault(code);
      process.stderr.write(`worker-monitor ${code}\n`);
    }
  }

  private write(id: "worker" | "poll", initial = false): void {
    const binding = this.binding;
    if (!binding?.inspect().held) throw new Error("Worker ownership lost");
    const now = this.now(); const wall = now.getTime();
    if (!Number.isFinite(wall) || wall < this.latestWall) throw new Error("Monitoring clock moved backwards");
    const state = binding.inspect();
    const payload = this.store.redactor.json({ phase: state.phase, activeRunId: state.activeRunId });
    if (initial) this.sql.prepare(`insert into worker_monitor_state values (?, ?, 1, ?, ?)
      on conflict(id) do update set session=excluded.session, sequence=worker_monitor_state.sequence+1, observed_at=excluded.observed_at, payload_json=excluded.payload_json`).run(id, binding.session, now.toISOString(), payload);
    else {
      const updated = this.sql.prepare("update worker_monitor_state set sequence=sequence+1, observed_at=?, payload_json=? where id=? and session=?").run(now.toISOString(), payload, id, binding.session);
      if (updated.changes !== 1) throw new Error("Monitoring session mismatch");
    }
    this.latestWall = wall;
    if (id === "worker") this.heartbeatMono = this.monotonic(); else this.pollMono = this.monotonic();
  }

  private sample(id: "worker" | "poll") {
    const value = this.sql.prepare("select * from worker_monitor_state where id=?").get(id);
    if (!value) return undefined;
    const row = sampleSchema.parse(value);
    return { ...row, payload: payloadSchema.parse(JSON.parse(row.payload_json)) };
  }

  private freshness(sample: ReturnType<RuntimeMonitoring["sample"]>, limit: number, mono: number | undefined): Freshness {
    if (!sample) return "missing";
    const wall = this.now().getTime(); const age = wall - Date.parse(sample.observed_at);
    if (!Number.isFinite(wall) || wall < this.latestWall || age < 0) return "unknown";
    if (this.binding && sample.session !== this.binding.session) return "unknown";
    if (mono !== undefined) {
      const elapsed = this.monotonic() - mono;
      if (!Number.isFinite(elapsed) || elapsed < 0) return "unknown";
      if (elapsed >= limit) return "stale";
    }
    return age >= limit ? "stale" : "fresh";
  }

  read(): WorkerHealth {
    try {
      this.sql.prepare("select 1").get();
      const worker = this.sample("worker"); const poll = this.sample("poll");
      const state = this.binding?.inspect() ?? { held: false, phase: "unowned" as const, activeRunId: null };
      const heartbeat = this.freshness(worker, this.policy.staleMs, this.heartbeatMono);
      const monitoring = this.freshness(poll, this.policy.overdueMs, this.pollMono);
      const reasons: string[] = [];
      if (!state.held) reasons.push("worker_not_owned");
      if (state.phase !== "ready") reasons.push(`worker_${state.phase}`);
      if (heartbeat !== "fresh") reasons.push(`heartbeat_${heartbeat}`);
      if (monitoring !== "fresh") reasons.push(`monitor_${monitoring}`);
      return { ready: reasons.length === 0, database: "connected", worker: { locallyOwned: state.held, session: worker?.session ?? null, phase: state.phase, heartbeat, lastHeartbeatAt: worker?.observed_at ?? null, activeRunId: state.activeRunId }, monitor: { freshness: monitoring, lastPolledAt: poll?.observed_at ?? null }, reasons };
    } catch {
      const state = this.binding?.inspect();
      return { ready: false, database: "unavailable", worker: { locallyOwned: state?.held ?? false, session: this.binding?.session ?? null, phase: state?.phase ?? "unowned", heartbeat: "unknown", lastHeartbeatAt: null, activeRunId: state?.activeRunId ?? null }, monitor: { freshness: "unknown", lastPolledAt: null }, reasons: ["monitoring_unavailable"] };
    }
  }

  assertReady(): void {
    if (this.read().ready) return;
    this.binding?.fault("worker_not_ready");
    throw Object.assign(new Error("Worker is not ready; drain and restart the worker"), { statusCode: 503 });
  }

  private poll(initial = false): void {
    const binding = this.binding;
    if (!binding) throw new Error("Monitoring is not bound");
    const health = this.read();
    if (!initial && (health.worker.heartbeat !== "fresh" || health.monitor.freshness !== "fresh")) binding.fault("monitoring_progress_lost");
    this.sql.transaction(() => {
      const now = this.now(); const windowStart = new Date(now.getTime() - this.policy.errorWindowMs).toISOString();
      const { count: failedRuns } = z.object({ count: z.number().int().nonnegative() }).parse(this.sql.prepare("select count(distinct run_id) as count from runtime_events where type='run.failed' and julianday(timestamp) > julianday(?) and julianday(timestamp) <= julianday(?)").get(windowStart, now.toISOString()));
      const { watermark } = z.object({ watermark: z.number().int().nonnegative() }).parse(this.sql.prepare("select coalesce(max(sequence),0) as watermark from runtime_events").get());
      const phase = binding.inspect().phase;
      const verdicts = evaluateMonitorConditions({ heartbeat: health.worker.heartbeat, phase, failedRuns, errorThreshold: this.policy.errorThreshold });
      for (const [condition, verdict] of Object.entries(verdicts)) {
        if (verdict === "unknown") continue;
        const previous = this.sql.prepare("select * from worker_alert_state where condition=?").get(condition);
        const head = previous ? z.object({ generation: z.number().int(), active: z.number().int().min(0).max(1) }).parse(previous) : { generation: 0, active: 0 };
        const active = verdict === "active" ? 1 : 0;
        if (head.active === active) continue;
        const activeRunId = binding.inspect().activeRunId;
        const runIds = condition === "error_burst"
          ? this.sql.prepare("select run_id from runtime_events where type='run.failed' and julianday(timestamp) > julianday(?) and julianday(timestamp) <= julianday(?) group by run_id order by max(sequence) desc limit 20").all(windowStart, now.toISOString()).map((row) => z.object({ run_id: z.string() }).parse(row).run_id)
          : activeRunId ? [activeRunId] : [];
        const evidence = evidenceSchema.parse({ ruleVersion: 1, session: binding.session, watermark, failedRuns, windowStart, heartbeat: health.worker.heartbeat, phase,
          source: condition === "error_burst" ? "runtime" : "worker", severity: condition === "error_burst" ? "warning" : "critical", runIds, sampleTruncated: condition === "error_burst" && failedRuns > runIds.length });
        const generation = head.generation + (active ? 1 : 0);
        this.sql.prepare("insert into worker_alert_state values (?, ?, ?) on conflict(condition) do update set generation=excluded.generation, active=excluded.active").run(condition, generation, active);
        this.sql.prepare("insert into worker_alert_transitions(condition,generation,edge,observed_at,evidence_json) values (?,?,?,?,?)").run(condition, generation, active ? "open" : "recovery", now.toISOString(), this.store.redactor.json(evidence));
      }
      this.write("poll", initial);
    }).immediate();
  }

  alerts(afterSequence?: number, limit = 100) {
    z.number().int().nonnegative().optional().parse(afterSequence); z.number().int().min(1).max(500).parse(limit);
    const rows = afterSequence === undefined
      ? this.sql.prepare("select * from worker_alert_transitions order by sequence desc limit ?").all(limit).reverse()
      : this.sql.prepare("select * from worker_alert_transitions where sequence > ? order by sequence limit ?").all(afterSequence, limit);
    return rows.map((value) => {
      const row = transitionSchema.parse(value);
      return { sequence: row.sequence, condition: row.condition, generation: row.generation, edge: row.edge, observedAt: row.observed_at, evidence: evidenceSchema.parse(JSON.parse(row.evidence_json)) };
    });
  }

  disposeAfterDrain(): void {
    this.running = false;
    const failures: unknown[] = [];
    for (const dispose of this.disposers.splice(0)) { try { dispose(); } catch (error) { failures.push(error); } }
    if (this.binding && this.sql.open) { try { this.write("worker"); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "Monitoring cleanup failed", { cause: failures[0] });
  }
}
