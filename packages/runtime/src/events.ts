import { z } from "zod";
import { observationContextSchema, observationStartSchema, observationCompleteSchema, observationDeniedSchema } from "./telemetry.js";

const count = z.number().int().nonnegative();
const measured = {
  durationMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  detail: z.string().optional(),
};
const stage = z.object({ ...measured, count }).catchall(z.json());
const note = z.object(measured).catchall(z.json());

const payloadSchemas = {
  "observation.context": observationContextSchema,
  "observation.started": observationStartSchema,
  "observation.completed": observationCompleteSchema,
  "observation.denied": observationDeniedSchema,
  "scheduler.task_due": z.object({ ...measured, scheduleId: z.string().optional(), taskId: z.string().optional(), reason: z.string().optional() }).catchall(z.json()),
  "run.queued": z.object({ title: z.string().min(1), taskId: z.string().min(1), trigger: z.enum(["manual", "schedule", "demo"]) }).catchall(z.json()),
  "run.started": z.object({ ...measured, title: z.string().min(1), taskId: z.string().optional(), trigger: z.enum(["manual", "schedule", "demo"]).default("manual") }).catchall(z.json()),
  "agent.prompt": note.extend({ prompt: z.string(), systemPrompt: z.string() }),
  "agent.turn.started": note.extend({ turn: count.positive() }),
  "agent.model.completed": note.extend({ turn: count.positive(), status: z.enum(["ok", "error"]), model: z.string() }),
  "agent.output.delta": note.extend({ turn: count.positive(), delta: z.string() }),
  "agent.tool.started": note.extend({ callId: z.string().min(1), tool: z.string().min(1), arguments: z.json() }),
  "agent.tool.completed": note.extend({ callId: z.string().min(1), tool: z.string().min(1), isError: z.boolean(), result: z.json() }),
  "source.read.completed": note.extend({ sourceId: z.string().min(1), status: z.enum(["ok", "failed"]) }),
  "pipeline.fetch.started": z.object({ ...measured, sourceCount: count, sources: z.array(z.string()) }).catchall(z.json()),
  "pipeline.fetch.completed": z.object({ ...measured, count: count.optional(), source: z.string().optional(), failedSources: z.array(z.string()).default([]) }).catchall(z.json()).refine((value) => value.count !== undefined || value.failedSources.length > 0, "Fetch result requires a count or failed sources"),
  "pipeline.clean.completed": stage,
  "pipeline.dedupe.completed": stage.extend({ removed: count.optional() }),
  "pipeline.rank.completed": stage,
  "pipeline.summarize.completed": stage,
  "delivery.created": z.object({ ...measured, count: count.positive(), digest: z.string(), deliveryIds: z.array(z.string()).optional() }).catchall(z.json()),
  "delivery.skipped": z.object({ ...measured, count: z.literal(0), reason: z.literal("no_new_items"), digest: z.literal("") }).catchall(z.json()),
  "memory.preference.updated": note,
  "memory.practice.changed": note.extend({ action: z.enum(["proposed", "reviewed", "evaluated", "activate", "rollback", "clear"]) }),
  "eval.completed": note,
  "security.policy.checked": note,
  "security.policy.denied": z.object({ ...measured, reason: z.string().min(1) }).catchall(z.json()),
  "run.completed": note,
  "run.failed": note.extend({ reason: z.string().min(1) }),
  "run.cancelled": note.extend({ reason: z.string().min(1) }),
  "run.cancel_requested": note.extend({ reason: z.string().min(1), actor: z.string().optional() }),
  "run.skipped": note.extend({ reason: z.string().min(1) }),
};

export type RuntimeEventType = keyof typeof payloadSchemas;
const envelope = z.object({
  id: z.string().min(1).max(1024),
  runId: z.string().min(1).max(256),
  type: z.custom<RuntimeEventType>((value) => typeof value === "string" && Object.hasOwn(payloadSchemas, value), "Unknown runtime event type"),
  source: z.string().min(1).max(256),
  severity: z.enum(["info", "warning", "error", "critical"]),
  timestamp: z.iso.datetime({ offset: true }),
  schemaVersion: z.union([z.literal(0), z.literal(1)]).default(1),
  payload: z.record(z.string(), z.json()),
}).strict();

export type RuntimeEvent = z.infer<typeof envelope>;

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  const result = envelope.safeParse(value);
  if (!result.success) throw new Error("Invalid runtime event envelope");
  const event = result.data;
  if (event.schemaVersion === 0) return event;
  const payload = payloadSchemas[event.type].safeParse(event.payload);
  if (!payload.success) throw new Error(`Invalid runtime event payload: ${event.type}`);
  return { ...event, payload: payload.data };
}
