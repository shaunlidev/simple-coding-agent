import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { frozenPriceSchema, costReadingSchema, reportedUsageSchema, priceUsage, freezePrice } from "./pricing.js";
import type { SQLiteRuntimeStore } from "./index.js";
import type { RuntimeEvent } from "./events.js";

const traceId = z.string().regex(/^[a-f0-9]{32}$/).refine((value) => !/^0+$/.test(value));
const spanId = z.string().regex(/^[a-f0-9]{16}$/).refine((value) => !/^0+$/.test(value));
const unknownReading = z.object({ kind: z.literal("unknown"), reason: z.string().min(1).max(500) }).strict();
const notApplicable = z.object({ kind: z.literal("not_applicable") }).strict();
const usageReadingSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("reported"), value: reportedUsageSchema }).strict(), unknownReading, notApplicable]);
const operationDetails = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("llm"), provider: z.string().min(1), model: z.string().min(1), turn: z.number().int().positive(), billing: z.enum(["paid", "demo"]), price: frozenPriceSchema, reservation: costReadingSchema, inputEstimate: z.object({ method: z.literal("utf8_bytes_plus_message_overhead_v1"), tokens: z.number().int().nonnegative() }).strict().optional() }).strict(),
  z.object({ kind: z.enum(["tool", "source", "browser", "memory", "eval", "delivery", "security", "scheduler"]), attributes: z.record(z.string(), z.json()).default({}) }).strict(),
]);
export const observationContextSchema = z.object({ traceId, rootSpanId: spanId, mode: z.enum(["live", "demo"]), startedAt: z.iso.datetime() }).strict();
export const observationStartSchema = z.object({
  operationId: z.uuid(), traceId, spanId, parentSpanId: spanId, name: z.string().min(1).max(200), startedAt: z.iso.datetime(), details: operationDetails,
}).strict();
const terminalIntentSchema = z.object({
  operationId: z.uuid(),
  result: z.discriminatedUnion("state", [
    z.object({ state: z.literal("finished"), outcome: z.enum(["ok", "error", "cancelled", "denied"]), endedAt: z.iso.datetime(), durationMs: z.number().nonnegative(), code: z.string().max(200).optional() }).strict(),
    z.object({ state: z.literal("interrupted"), observedAt: z.iso.datetime(), code: z.literal("worker_interrupted") }).strict(),
  ]),
  usage: usageReadingSchema,
  responseModel: z.string().min(1).max(200).nullable(),
}).strict();
export const observationCompleteSchema = terminalIntentSchema.extend({ cost: z.union([costReadingSchema, notApplicable]), intentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const observationDeniedSchema = z.object({ reason: z.string().min(1).max(500), operation: z.string().min(1).max(200) }).strict();
export type ObservationStart = z.infer<typeof observationStartSchema>;
export type ObservationComplete = z.infer<typeof observationCompleteSchema>;
export type ObservationIntent = z.infer<typeof terminalIntentSchema>;
export type ObservedOperation = { start: ObservationStart; completion: ObservationComplete | null };

const rowSchema = z.object({ type: z.string(), payload_json: z.string() });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

function settlement(start: ObservationStart, intent: ObservationIntent): ObservationComplete {
  const details = start.details;
  const paid = details.kind === "llm" && details.billing === "paid";
  if (!paid && intent.usage.kind !== "not_applicable") throw conflict("Nonpaid operation cannot claim paid usage");
  if (paid && intent.usage.kind === "not_applicable") throw conflict("Admitted paid operation needs accounting");
  if (intent.result.state === "interrupted" && (intent.responseModel !== null || paid && (intent.usage.kind !== "unknown" || intent.usage.reason !== "worker_interrupted"))) throw conflict("Interrupted operation cannot invent usage");
  const cost = !paid ? { kind: "not_applicable" as const }
    : intent.responseModel !== null && intent.responseModel !== details.model ? { kind: "unknown" as const, reason: "response_model_mismatch" }
    : priceUsage(intent.usage.kind === "reported" ? intent.usage.value : undefined, details.price);
  return observationCompleteSchema.parse({ ...intent, cost, intentHash: hash(intent) });
}

function identifier(bytes: number) {
  let value: string;
  do { value = randomBytes(bytes).toString("hex"); } while (/^0+$/.test(value));
  return value;
}

export class RuntimeTelemetry {
  constructor(private readonly store: SQLiteRuntimeStore) {}

  validateEvent(event: RuntimeEvent): void {
    if (event.type === "observation.context") {
      this.assertAdmission(event.runId);
      if (this.readContext(event.runId)) throw conflict("Run already has observation context");
      if (event.id !== `observation-context:${event.runId}`) throw conflict("Invalid observation context identity");
    } else if (event.type === "observation.started") {
      this.assertAdmission(event.runId);
      const start = observationStartSchema.parse(event.payload);
      const context = this.readContext(event.runId);
      const operations = this.operations(event.runId);
      if (!context || start.traceId !== context.traceId || start.parentSpanId !== context.rootSpanId && !operations.some(({ start: parent }) => parent.spanId === start.parentSpanId)) throw conflict("Observation parent is outside this trace");
      if (start.spanId === context.rootSpanId || operations.some(({ start: prior }) => prior.spanId === start.spanId || prior.operationId === start.operationId)) throw conflict("Duplicate observation identity");
      if (event.id !== `observation-start:${start.operationId}` || event.timestamp !== start.startedAt) throw conflict("Invalid observation start identity");
      if (start.details.kind === "llm") {
        const details = start.details;
        if ((details.billing === "demo") !== (context.mode === "demo")) throw conflict("Observation billing does not match run mode");
        if (details.price.kind === "priced") {
          const valid = freezePrice([details.price.rate], { provider: details.provider, model: details.model, at: start.startedAt });
          if (valid.kind !== "priced" || valid.hash !== details.price.hash) throw conflict("Price does not apply to admitted operation");
        }
        if (details.reservation.kind === "estimated" && (details.price.kind !== "priced" || details.reservation.rateHash !== details.price.hash || details.reservation.rateVersion !== details.price.rate.version || details.reservation.basis !== "preflight_input_estimate")) throw conflict("Reservation does not match admitted price");
      }
    } else if (event.type === "observation.completed") {
      const { cost, intentHash, ...intent } = observationCompleteSchema.parse(event.payload);
      const operation = this.operations(event.runId).find(({ start }) => start.operationId === intent.operationId);
      if (!operation) throw conflict("Cannot settle an unadmitted operation");
      if (operation.completion) throw conflict("Operation already settled");
      const expected = settlement(operation.start, intent);
      if (intentHash !== expected.intentHash || hash(cost) !== hash(expected.cost)) throw conflict("Settlement does not match admitted accounting");
      if (event.id !== `observation-complete:${intent.operationId}` || event.timestamp !== (intent.result.state === "finished" ? intent.result.endedAt : intent.result.observedAt)) throw conflict("Invalid observation settlement identity");
    }
  }

  private rows(runId: string) {
    return this.store.database.sqlite.prepare("select type,payload_json from runtime_events where run_id=? and type like 'observation.%' order by sequence").all(runId).map((row) => rowSchema.parse(row));
  }

  readContext(runId: string) {
    const row = this.rows(runId).find((entry) => entry.type === "observation.context");
    return row ? observationContextSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  private assertAdmission(runId: string) {
    this.store.assertRunExecutable(runId);
    if (this.store.database.sqlite.prepare("select 1 from runtime_events where run_id=? and type in ('run.completed','run.failed','run.cancelled','run.skipped','run.cancel_requested') limit 1").get(runId)) throw conflict("Run does not accept new observations");
    if (!this.store.database.sqlite.prepare("select 1 from runtime_events where run_id=? and type in ('run.queued','run.started') limit 1").get(runId)) throw conflict("Observation requires an admitted run");
  }

  context(runId: string, mode: "live" | "demo") {
    return this.store.database.sqlite.transaction(() => {
      const existing = this.readContext(runId);
      if (existing) { if (existing.mode !== mode) throw conflict("Observation mode cannot change"); return existing; }
      this.assertAdmission(runId);
      const first = z.object({ timestamp: z.string() }).parse(this.store.database.sqlite.prepare("select timestamp from runtime_events where run_id=? and type in ('run.queued','run.started') order by sequence limit 1").get(runId));
      const context = observationContextSchema.parse({ traceId: identifier(16), rootSpanId: identifier(8), mode, startedAt: first.timestamp });
      const event = this.store.createEvent(runId, "observation.context", context);
      this.store.appendEventSync({ ...event, id: `observation-context:${runId}` });
      return context;
    }).immediate();
  }

  start(runId: string, input: { mode: "live" | "demo"; name: string; details: ObservationStart["details"]; parentSpanId?: string; startedAt?: string }): ObservationStart {
    return this.store.database.sqlite.transaction(() => {
      this.assertAdmission(runId);
      const context = this.context(runId, input.mode);
      const parent = input.parentSpanId ?? context.rootSpanId;
      if (parent !== context.rootSpanId && !this.operations(runId).some((entry) => entry.start.spanId === parent && entry.start.traceId === context.traceId)) throw conflict("Observation parent is outside this trace");
      if (input.details.kind === "llm" && (input.details.billing === "demo") !== (context.mode === "demo")) throw conflict("Observation billing does not match run mode");
      const start = observationStartSchema.parse({ operationId: randomUUID(), traceId: context.traceId, spanId: identifier(8), parentSpanId: parent, name: input.name, startedAt: input.startedAt ?? new Date().toISOString(), details: input.details });
      const event = this.store.createEvent(runId, "observation.started", start);
      const written = this.store.appendEventSync({ ...event, id: `observation-start:${start.operationId}`, timestamp: start.startedAt });
      return observationStartSchema.parse(written.payload);
    }).immediate();
  }

  complete(runId: string, input: ObservationIntent): ObservationComplete {
    return this.store.database.sqlite.transaction(() => {
      const intent = terminalIntentSchema.parse(this.store.redactor.value(input));
      const operation = this.operations(runId).find((entry) => entry.start.operationId === intent.operationId);
      if (!operation) throw conflict("Cannot settle an unadmitted operation");
      const intentHash = hash(intent);
      if (operation.completion) {
        if (operation.completion.intentHash !== intentHash) throw conflict("Conflicting operation settlement");
        return operation.completion;
      }
      const completion = settlement(operation.start, intent);
      const at = intent.result.state === "finished" ? intent.result.endedAt : intent.result.observedAt;
      const event = this.store.createEvent(runId, "observation.completed", completion, { severity: intent.result.state === "finished" && intent.result.outcome === "ok" ? "info" : "warning" });
      // Accounting for existing dispatches survives the execution fence; it authorizes no new work.
      const written = this.store.appendEventSync({ ...event, id: `observation-complete:${intent.operationId}`, timestamp: at });
      return observationCompleteSchema.parse(written.payload);
    }).immediate();
  }

  operations(runId: string): ObservedOperation[] {
    const rows = this.rows(runId);
    const completed = new Map(rows.filter((row) => row.type === "observation.completed").map((row) => { const value = observationCompleteSchema.parse(JSON.parse(row.payload_json)); return [value.operationId, value] as const; }));
    return rows.filter((row) => row.type === "observation.started").map((row) => { const start = observationStartSchema.parse(JSON.parse(row.payload_json)); return { start, completion: completed.get(start.operationId) ?? null }; });
  }

  interruptOpen(runId: string, observedAt = new Date().toISOString()) {
    return this.store.database.sqlite.transaction(() => this.operations(runId).filter((operation) => !operation.completion).map(({ start }) => this.complete(runId, {
      operationId: start.operationId, result: { state: "interrupted", observedAt, code: "worker_interrupted" },
      usage: start.details.kind === "llm" && start.details.billing === "paid" ? { kind: "unknown", reason: "worker_interrupted" } : { kind: "not_applicable" }, responseModel: null,
    }))).immediate();
  }

  deny(runId: string, operation: string, reason: string) {
    return this.store.appendEventSync(this.store.createEvent(runId, "observation.denied", observationDeniedSchema.parse({ operation, reason }), { severity: "warning" }));
  }
}
