import type { RuntimeEvent } from "./events.js";
import type { RuntimeRun, RuntimeSpan, EvalGate } from "./index.js";
import { observationContextSchema, observationStartSchema, observationCompleteSchema, type ObservedOperation } from "./telemetry.js";

export type Accounting = {
  usageStatus: "reported" | "partial" | "unknown" | "not_applicable";
  costStatus: "estimated" | "partial" | "unknown" | "not_applicable";
  modelCalls: number; unknownUsageCalls: number; unknownCostCalls: number;
  knownInputTokens: number; knownOutputTokens: number; knownCostUsd: number;
};
export type Latency = { samples: number; p50Ms: number | null; p95Ms: number | null; method: "nearest_rank" };
export type RuntimeMetrics = {
  window: { from: string; to: string; population: "live" };
  successRate: number | null; errorRate: number | null;
  terminalRuns: number; completedRuns: number; failedRuns: number; cancelledRuns: number;
  runLatency: Latency; toolLatency: Latency; modelLatency: Latency;
  costUsd: number | null; inputTokens: number | null; outputTokens: number | null;
  accounting: Accounting; toolFailures: number; toolCalls: number;
  evalPassRate: number | null; evalReports: number; evalScope: "latest_non_skipped_reports";
  events: number;
};

function facts(events: RuntimeEvent[]) {
  const context = events.find((event) => event.type === "observation.context");
  const starts = new Map(events.filter((event) => event.type === "observation.started").map((event) => { const start = observationStartSchema.parse(event.payload); return [start.operationId, start] as const; }));
  const ends = new Map(events.filter((event) => event.type === "observation.completed").map((event) => { const end = observationCompleteSchema.parse(event.payload); return [end.operationId, end] as const; }));
  return { context: context ? observationContextSchema.parse(context.payload) : undefined, operations: [...starts.values()].map((start): ObservedOperation => ({ start, completion: ends.get(start.operationId) ?? null })) };
}

function accounting(operations: ObservedOperation[], observed: boolean) {
  const paid = operations.filter(({ start }) => start.details.kind === "llm" && start.details.billing === "paid");
  let knownInputTokens = 0; let knownOutputTokens = 0; let nanos = 0;
  let knownUsageCalls = 0; let knownCostCalls = 0;
  for (const { completion } of paid) {
    if (completion?.usage.kind === "reported") { knownUsageCalls++; knownInputTokens += completion.usage.value.input; knownOutputTokens += completion.usage.value.output; }
    if (completion?.cost.kind === "estimated") { knownCostCalls++; nanos += completion.cost.nanoUsd; }
  }
  const overflow = !Number.isSafeInteger(knownInputTokens) || !Number.isSafeInteger(knownOutputTokens) || !Number.isSafeInteger(nanos);
  const missing = paid.length === 0 ? observed ? "not_applicable" : "unknown" : "unknown";
  const reading: Accounting = {
    usageStatus: overflow ? "unknown" : !paid.length ? missing : knownUsageCalls === paid.length ? "reported" : knownUsageCalls ? "partial" : "unknown",
    costStatus: overflow ? "unknown" : !paid.length ? missing : knownCostCalls === paid.length ? "estimated" : knownCostCalls ? "partial" : "unknown",
    modelCalls: paid.length, unknownUsageCalls: paid.length - knownUsageCalls, unknownCostCalls: paid.length - knownCostCalls,
    knownInputTokens, knownOutputTokens, knownCostUsd: nanos / 1_000_000_000,
  };
  return { accounting: reading, costUsd: reading.costStatus === "estimated" ? reading.knownCostUsd : null, inputTokens: reading.usageStatus === "reported" ? knownInputTokens : null, outputTokens: reading.usageStatus === "reported" ? knownOutputTokens : null };
}

export function projectRun(runId: string, events: RuntimeEvent[]): RuntimeRun {
  const started = events.find((event) => event.type === "run.started");
  const requested = started ?? events.find((event) => event.type === "run.queued");
  const completed = [...events].reverse().find((event) => ["run.completed", "run.failed", "run.cancelled", "run.skipped"].includes(event.type));
  const status = completed?.type === "run.completed" ? "completed" : completed?.type === "run.failed" ? "failed" : completed?.type === "run.cancelled" ? "cancelled" : completed?.type === "run.skipped" ? "skipped" : events.some((event) => event.type === "run.cancel_requested") ? "cancelling" : started ? "running" : "queued";
  const observed = facts(events);
  const demo = observed.context?.mode === "demo" || requested?.payload.mode === "demo" || requested?.payload.trigger === "demo";
  const duration = completed?.payload.durationMs;
  return {
    id: runId, taskId: String(requested?.payload.taskId ?? "content"), title: String(requested?.payload.title ?? "Content run"),
    trigger: requested?.payload.trigger === "demo" ? "demo" : requested?.payload.trigger === "schedule" ? "schedule" : "manual", status,
    mode: demo ? "demo" : observed.context?.mode === "live" ? "live" : "unknown",
    startedAt: started?.timestamp, completedAt: completed?.timestamp,
    ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
    ...accounting(demo ? [] : observed.operations, Boolean(observed.context) || demo),
    toolCallCount: observed.operations.filter(({ start }) => start.details.kind === "tool").length,
    errorCount: events.filter((event) => event.severity === "error" || event.severity === "critical").length,
  };
}

export function projectRuns(events: RuntimeEvent[]): RuntimeRun[] {
  const groups = new Map<string, RuntimeEvent[]>();
  const admitted: string[] = [];
  for (const event of events) {
    const group = groups.get(event.runId) ?? [];
    groups.set(event.runId, group); group.push(event);
    if (["run.started", "run.queued"].includes(event.type) && !admitted.includes(event.runId)) admitted.push(event.runId);
  }
  return admitted.reverse().map((runId) => projectRun(runId, groups.get(runId) ?? []));
}

export function projectSpans(run: RuntimeRun, events: RuntimeEvent[]): RuntimeSpan[] {
  const { context, operations } = facts(events);
  if (!context) return [];
  const rootId = `${run.id}:root`;
  const terminal = ["completed", "failed", "cancelled", "skipped"].includes(run.status);
  const rootDuration = run.completedAt ? Date.parse(run.completedAt) - Date.parse(context.startedAt) : undefined;
  const root: RuntimeSpan = {
    id: rootId, traceId: context.traceId, spanId: context.rootSpanId, runId: run.id, type: "root", name: run.title,
    status: !terminal ? "running" : run.status === "failed" ? "error" : run.status === "cancelled" ? "cancelled" : run.status === "skipped" ? "skipped" : "ok",
    startedAt: context.startedAt, endedAt: run.completedAt, durationMs: rootDuration !== undefined && rootDuration >= 0 ? rootDuration : null,
    costUsd: run.costUsd, inputTokens: run.inputTokens, outputTokens: run.outputTokens,
    costStatus: run.accounting.costStatus, usageStatus: run.accounting.usageStatus,
    summary: `${run.trigger} run ${run.status}`, attributes: { "agent.run_id": run.id, "agent.task_id": run.taskId, "agent.mode": run.mode, "agent.duration_basis": "lifecycle_wall_clock", "agent.telemetry.schema": "r7-v1" },
  };
  return [root, ...operations.map(({ start, completion }): RuntimeSpan => {
    const result = completion?.result;
    const model = start.details.kind === "llm" ? start.details : undefined;
    const usage = completion?.usage.kind === "reported" ? completion.usage.value : undefined;
    return {
      id: start.operationId, traceId: start.traceId, spanId: start.spanId, parentSpanId: start.parentSpanId,
      parentId: start.parentSpanId === context.rootSpanId ? rootId : operations.find(({ start: parent }) => parent.spanId === start.parentSpanId)?.start.operationId,
      runId: run.id, type: start.details.kind, name: start.name,
      status: !result ? "running" : result.state === "interrupted" ? "interrupted" : result.outcome,
      startedAt: start.startedAt, endedAt: result?.state === "finished" ? result.endedAt : undefined, durationMs: result?.state === "finished" ? result.durationMs : null,
      costUsd: completion?.cost.kind === "estimated" ? completion.cost.usd : null,
      inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null,
      costStatus: completion?.cost.kind ?? (model?.billing === "paid" ? "unknown" : "not_applicable"),
      usageStatus: completion?.usage.kind ?? (model?.billing === "paid" ? "unknown" : "not_applicable"),
      summary: !result ? "In progress" : result.state === "interrupted" ? "Worker interrupted; end time unknown" : result.code ?? result.outcome,
      attributes: { "agent.operation_id": start.operationId, "agent.duration_basis": "monotonic", ...(model ? { "gen_ai.operation.name": "chat", "gen_ai.provider.name": model.provider, "gen_ai.request.model": model.model, "agent.billing": model.billing } : {}), ...(usage ? { "gen_ai.usage.input_tokens": usage.input, "gen_ai.usage.output_tokens": usage.output } : {}) },
    };
  })];
}

export function latency(values: number[]): Latency {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), method: "nearest_rank" };
}

export function projectMetrics(events: RuntimeEvent[], evals: EvalGate[], now = new Date()): RuntimeMetrics {
  const to = now.getTime(); const from = to - 86400000;
  const inside = (at: string | undefined) => at !== undefined && Date.parse(at) >= from && Date.parse(at) <= to;
  const runs = projectRuns(events).filter((run) => run.mode === "live");
  const ids = new Set(runs.map((run) => run.id));
  const liveEvents = events.filter((event) => ids.has(event.runId));
  const terminal = runs.filter((run) => ["completed", "failed", "cancelled"].includes(run.status) && inside(run.completedAt));
  const operations = facts(liveEvents).operations;
  const inWindow = operations.filter(({ start, completion }) => inside(completion?.result.state === "finished" ? completion.result.endedAt : completion?.result.state === "interrupted" ? completion.result.observedAt : start.startedAt));
  const duration = (kind: string) => inWindow.flatMap(({ start, completion }) => start.details.kind === kind && completion?.result.state === "finished" ? [completion.result.durationMs] : []);
  const count = (status: RuntimeRun["status"]) => terminal.filter((run) => run.status === status).length;
  const reports = evals.filter((report) => report.status !== "skipped");
  return {
    window: { from: new Date(from).toISOString(), to: now.toISOString(), population: "live" },
    successRate: terminal.length ? count("completed") / terminal.length : null, errorRate: terminal.length ? count("failed") / terminal.length : null,
    terminalRuns: terminal.length, completedRuns: count("completed"), failedRuns: count("failed"), cancelledRuns: count("cancelled"),
    runLatency: latency(terminal.flatMap((run) => run.durationMs === undefined ? [] : [run.durationMs])), toolLatency: latency(duration("tool")), modelLatency: latency(duration("llm")),
    ...accounting(inWindow, runs.length > 0),
    toolFailures: inWindow.filter(({ start, completion }) => start.details.kind === "tool" && completion && (completion.result.state === "interrupted" || completion.result.outcome !== "ok")).length,
    toolCalls: inWindow.filter(({ start }) => start.details.kind === "tool").length,
    evalPassRate: reports.length ? reports.filter((report) => report.status === "passed").length / reports.length : null, evalReports: reports.length, evalScope: "latest_non_skipped_reports",
    events: liveEvents.filter((event) => inside(event.timestamp)).length,
  };
}

export function exportTrace(runId: string, spans: RuntimeSpan[]) {
  if (spans.length > 1000) throw Object.assign(new Error("Trace export exceeds 1000 spans"), { statusCode: 413 });
  const attributes = (values: Record<string, string | number | boolean>) => Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : { doubleValue: value } }));
  const finished = spans.flatMap((span) => span.endedAt !== undefined && Date.parse(span.endedAt) >= Date.parse(span.startedAt) ? [{ span, endedAt: span.endedAt }] : []);
  const output = {
    runId, schemaVersion: "r7-v1", spans, omittedFromOtlp: spans.filter((span) => !finished.some((entry) => entry.span === span)).map((span) => ({ spanId: span.spanId, reason: span.status === "interrupted" ? "end_unknown" : "unfinished_or_clock_discontinuity" })),
    otlp: { resourceSpans: [{ resource: { attributes: attributes({ "service.name": "simple-coding-agent" }) }, scopeSpans: [{ scope: { name: "simple-coding-agent.runtime", version: "1" }, spans: finished.map(({ span, endedAt }) => ({ traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}), name: span.name, kind: span.type === "llm" || span.type === "source" || span.type === "browser" ? 3 : 1, startTimeUnixNano: (BigInt(Date.parse(span.startedAt)) * 1_000_000n).toString(), endTimeUnixNano: (BigInt(Date.parse(endedAt)) * 1_000_000n).toString(), attributes: attributes({ ...span.attributes, "agent.outcome": span.status }), status: { code: span.status === "ok" ? 0 : 2 } })) }] }] },
  };
  if (Buffer.byteLength(JSON.stringify(output)) > 1_000_000) throw Object.assign(new Error("Trace export exceeds 1MB"), { statusCode: 413 });
  return output;
}
