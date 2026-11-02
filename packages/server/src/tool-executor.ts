import { createHash, randomUUID } from "node:crypto";
import type { SQLiteRuntimeStore } from "@simple-coding-agent/runtime";
import { z } from "zod";

const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
export type RegisteredTool = {
  requiresApproval: boolean;
  parameters: z.ZodType<Json>;
  execute: (args: Json, context: { actor: string; runId: string }) => Promise<unknown>;
};
const approvalSchema = z.object({
  id: z.string(), run_id: z.string(), tool: z.string(), args_hash: z.string(),
  requested_by: z.string(), approved_by: z.string().nullable(),
  status: z.enum(["pending", "approved", "consumed", "denied"]),
  expires_at: z.number(), consumed_at: z.number().nullable(), created_at: z.number(),
});

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function denied(message: string) { return Object.assign(new Error(message), { statusCode: 403 }); }

export class GuardedToolExecutor {
  constructor(private readonly options: { runtime: SQLiteRuntimeStore; tools: ReadonlyMap<string, RegisteredTool>; now?: () => number }) {}

  private now() { return this.options.now?.() ?? Date.now(); }

  private async bind(input: { runId: string; tool: string; args: unknown }) {
    const tool = this.options.tools.get(input.tool);
    if (!tool) throw denied("Tool is not registered for server execution");
    const events = await this.options.runtime.listEvents(input.runId);
    if (!events.some((event) => event.type === "run.started")) throw denied("Run binding is invalid");
    const args = tool.parameters.parse(input.args);
    const hash = createHash("sha256").update(canonical(args)).digest("hex");
    return { tool, args, hash };
  }

  private async audit(input: { runId: string; tool: string; actor: string }, decision: string, approvalId?: string) {
    await this.options.runtime.recordSecurityAudit({ runId: input.runId, action: input.tool, severity: decision === "denied" ? "warning" : "info", message: JSON.stringify({ actor: input.actor, decision, approvalId }) });
  }

  async requestApproval(input: { runId: string; tool: string; args: unknown; actor: string }) {
    const { tool, hash } = await this.bind(input);
    if (!tool.requiresApproval) throw denied("This tool does not require approval");
    const id = randomUUID();
    const now = this.now();
    this.options.runtime.database.sqlite.prepare("insert into execution_approvals (id, run_id, tool, args_hash, requested_by, status, expires_at, created_at) values (?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, input.runId, input.tool, hash, input.actor, now + 5 * 60 * 1000, now);
    await this.audit(input, "approval_requested", id);
    return this.getApproval(id);
  }

  getApproval(id: string) {
    const row = this.options.runtime.database.sqlite.prepare("select * from execution_approvals where id = ?").get(id);
    if (!row) throw denied("Approval does not exist");
    return approvalSchema.parse(row);
  }

  listApprovals() {
    return this.options.runtime.database.sqlite.prepare("select * from execution_approvals order by created_at desc limit 200").all().map((row) => approvalSchema.parse(row));
  }

  async approve(id: string, actor: string) {
    const result = this.options.runtime.database.sqlite.prepare("update execution_approvals set status = 'approved', approved_by = ? where id = ? and status = 'pending' and expires_at > ?")
      .run(actor, id, this.now());
    if (result.changes !== 1) throw denied("Approval is not pending or has expired");
    const record = this.getApproval(id);
    await this.audit({ runId: record.run_id, tool: record.tool, actor }, "approved", id);
    return record;
  }

  async execute(input: { runId: string; tool: string; args: unknown; actor: string; approvalId?: string }) {
    let authorized = false;
    try {
      const { tool, args, hash } = await this.bind(input);
      if (tool.requiresApproval) {
        if (!input.approvalId) throw denied("A bound approval is required");
        // Commit consumption before the side effect; failed operations need a fresh approval.
        const result = this.options.runtime.database.sqlite.prepare("update execution_approvals set status = 'consumed', consumed_at = ? where id = ? and run_id = ? and tool = ? and args_hash = ? and requested_by = ? and status = 'approved' and approved_by is not null and expires_at > ?")
          .run(this.now(), input.approvalId, input.runId, input.tool, hash, input.actor, this.now());
        if (result.changes !== 1) throw denied("Approval is expired, consumed or does not match this operation");
      }
      await this.audit(input, "execution_authorized", input.approvalId);
      authorized = true;
      const result = await tool.execute(args, { actor: input.actor, runId: input.runId });
      await this.audit(input, "execution_completed", input.approvalId);
      return result;
    } catch (error) {
      await this.audit(input, authorized ? "execution_failed" : "denied", input.approvalId);
      throw error;
    }
  }
}
