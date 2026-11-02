import type { AgentDispatch } from "@simple-coding-agent/agent";
import type { AssistantMessage, ProviderContext, ToolMessage } from "@simple-coding-agent/ai";
import { z } from "zod";
import type { SQLiteRuntimeStore } from "./index.js";
import type { ContentTask } from "./content-contract.js";
import { sourceReadSchema, type SourceRead } from "./content-contract.js";
import { freezePrice, estimateCallReservation, priceCatalogSchema, reportedUsageSchema } from "./pricing.js";
import type { ObservationComplete, ObservationStart } from "./telemetry.js";
import type { RuntimeEventType } from "./events.js";

function estimateInput(context: ProviderContext) {
  const tools = context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) ?? [];
  const bytes = Buffer.byteLength(JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages, tools }), "utf8");
  return { method: "utf8_bytes_plus_message_overhead_v1" as const, tokens: bytes + 64 * (1 + context.messages.length + tools.length) };
}

export class ContentDispatch implements AgentDispatch {
  private readonly prices: z.infer<typeof priceCatalogSchema>;
  private activeToolSpanId: string | undefined;

  constructor(private readonly store: SQLiteRuntimeStore, private readonly runId: string, private readonly task: ContentTask, private readonly signal: AbortSignal, prices: unknown = []) {
    this.prices = priceCatalogSchema.parse(prices);
  }

  private audit(type: RuntimeEventType, payload: Record<string, unknown>, severity: "info" | "warning" | "error" = "info") {
    this.store.appendEventSync(this.store.createEvent(this.runId, type, payload, { source: "content-agent", severity }));
  }

  private assertDispatch() {
    this.signal.throwIfAborted();
    this.store.assertRunExecutable(this.runId);
  }

  private deny(reason: string): never {
    this.store.telemetry.deny(this.runId, "model.dispatch", reason);
    throw Object.assign(new Error(`Model budget denied: ${reason}`), { code: reason, retryable: false });
  }

  private accounting() {
    let tokens = 0;
    let nanoUsd = 0;
    for (const operation of this.store.telemetry.operations(this.runId)) {
      if (operation.start.details.kind !== "llm" || operation.start.details.billing !== "paid") continue;
      const completion = operation.completion;
      if (!completion) this.deny("accounting_unsettled");
      if (completion.usage.kind === "reported") tokens += completion.usage.value.totalTokens;
      else if (this.task.limits.maxTotalTokens !== undefined || this.task.limits.maxCostUsd !== undefined) this.deny("usage_unknown");
      if (completion.cost.kind === "estimated") nanoUsd += completion.cost.nanoUsd;
      else if (this.task.limits.maxCostUsd !== undefined) this.deny("cost_unknown");
    }
    if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(nanoUsd)) this.deny("accounting_out_of_range");
    return { tokens, nanoUsd };
  }

  private reconcile() {
    if (this.task.mode === "demo") return;
    const totals = this.accounting();
    if (this.task.limits.maxTotalTokens !== undefined && totals.tokens > this.task.limits.maxTotalTokens) this.deny("token_budget_exceeded");
    if (this.task.limits.maxCostUsd !== undefined && totals.nanoUsd > Math.floor(this.task.limits.maxCostUsd * 1_000_000_000)) this.deny("cost_budget_exceeded");
  }

  private finish(start: ObservationStart, began: number, outcome: "ok" | "error" | "cancelled" | "denied", usage: ObservationComplete["usage"], responseModel: string | null = null, code?: string) {
    return this.store.telemetry.complete(this.runId, { operationId: start.operationId, result: { state: "finished", outcome, endedAt: new Date().toISOString(), durationMs: Math.max(0, performance.now() - began), ...(code ? { code } : {}) }, usage, responseModel });
  }

  async model(call: Parameters<AgentDispatch["model"]>[0], invoke: Parameters<AgentDispatch["model"]>[1]): Promise<AssistantMessage> {
    this.assertDispatch();
    const startedAt = new Date().toISOString();
    const price = freezePrice(this.prices, { provider: call.model.provider, model: call.model.id, at: startedAt });
    const inputEstimate = estimateInput(call.context);
    const reservation = estimateCallReservation(price, { inputTokens: inputEstimate.tokens, maxOutputTokens: this.task.limits.maxOutputTokens });
    if (this.task.mode === "live") {
      const totals = this.accounting();
      if (this.task.limits.maxTotalTokens !== undefined && totals.tokens + inputEstimate.tokens + this.task.limits.maxOutputTokens > this.task.limits.maxTotalTokens) this.deny("token_budget_preflight");
      if (this.task.limits.maxCostUsd !== undefined) {
        if (reservation.kind !== "estimated") this.deny("price_unknown");
        if (totals.nanoUsd + reservation.nanoUsd > Math.floor(this.task.limits.maxCostUsd * 1_000_000_000)) this.deny("cost_budget_preflight");
      }
    }
    this.audit("agent.turn.started", { turn: call.turn });
    const began = performance.now();
    const operation = this.store.telemetry.start(this.runId, { mode: this.task.mode, startedAt, name: `chat ${call.model.id}`, details: { kind: "llm", provider: call.model.provider, model: call.model.id, turn: call.turn, billing: this.task.mode === "demo" ? "demo" : "paid", price, reservation, inputEstimate } });
    let message: AssistantMessage;
    try { message = await invoke({ signal: this.signal, maxOutputTokens: this.task.limits.maxOutputTokens }); }
    catch (error) {
      this.finish(operation, began, this.signal.aborted ? "cancelled" : "error", this.task.mode === "demo" ? { kind: "not_applicable" } : { kind: "unknown", reason: "provider_threw" }, null, "provider_threw");
      throw error;
    }
    const usage = reportedUsageSchema.safeParse(message.usage);
    const outcome = this.signal.aborted || message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : "ok";
    const completion = this.finish(operation, began, outcome, this.task.mode === "demo" ? { kind: "not_applicable" } : usage.success ? { kind: "reported", value: usage.data } : { kind: "unknown", reason: message.usage === undefined ? "usage_missing" : "usage_invalid" }, message.model ?? null, message.errorCode);
    this.assertDispatch();
    this.audit("agent.model.completed", { turn: call.turn, status: outcome === "ok" ? "ok" : "error", model: message.model ?? call.model.id, durationMs: completion.result.state === "finished" ? completion.result.durationMs : undefined, usage: completion.usage.kind === "reported" ? completion.usage.value : null, stopReason: message.stopReason, ...(completion.usage.kind === "reported" ? { inputTokens: completion.usage.value.input, outputTokens: completion.usage.value.output } : {}), ...(message.errorMessage ? { detail: message.errorMessage } : {}) }, outcome === "error" ? "error" : "info");
    this.reconcile();
    return message;
  }

  async tool(call: Parameters<AgentDispatch["tool"]>[0], invoke: Parameters<AgentDispatch["tool"]>[1]): Promise<ToolMessage> {
    this.assertDispatch();
    this.reconcile();
    this.audit("agent.tool.started", { callId: call.toolCall.id, tool: call.toolCall.name, arguments: call.toolCall.arguments });
    const began = performance.now();
    const operation = this.store.telemetry.start(this.runId, { mode: this.task.mode, name: call.toolCall.name, details: { kind: "tool", attributes: { callId: call.toolCall.id, turn: call.turn } } });
    this.activeToolSpanId = operation.spanId;
    let message: ToolMessage;
    let result: SourceRead | string;
    try {
      message = await invoke(this.signal);
      result = message.isError ? message.content : sourceReadSchema.parse(JSON.parse(message.content));
    }
    catch (error) { this.finish(operation, began, this.signal.aborted ? "cancelled" : "error", { kind: "not_applicable" }); throw error; }
    finally { this.activeToolSpanId = undefined; }
    const sourceFailed = typeof result !== "string" && result.status === "failed";
    const outcome = this.signal.aborted ? "cancelled" : message.isError || sourceFailed ? "error" : "ok";
    const completion = this.finish(operation, began, outcome, { kind: "not_applicable" });
    this.assertDispatch();
    this.audit("agent.tool.completed", { callId: message.toolCallId, tool: message.toolName, isError: message.isError === true, result, durationMs: completion.result.state === "finished" ? completion.result.durationMs : undefined }, outcome === "error" ? "warning" : "info");
    return message;
  }

  async operation<T>(kind: Exclude<ObservationStart["details"]["kind"], "llm">, name: string, work: () => T | Promise<T>, options: { attributes?: Record<string, z.infer<ReturnType<typeof z.json>>>; failed?: (value: T) => boolean } = {}): Promise<T> {
    this.assertDispatch();
    const began = performance.now();
    const operation = this.store.telemetry.start(this.runId, { mode: this.task.mode, name, parentSpanId: this.activeToolSpanId, details: { kind, attributes: options.attributes ?? {} } });
    let result: T;
    try { result = await work(); }
    catch (error) { this.finish(operation, began, this.signal.aborted ? "cancelled" : error instanceof Error && "statusCode" in error && error.statusCode === 403 ? "denied" : "error", { kind: "not_applicable" }); throw error; }
    this.finish(operation, began, this.signal.aborted ? "cancelled" : options.failed?.(result) ? "error" : "ok", { kind: "not_applicable" });
    return result;
  }
}
