import { createHash } from "node:crypto";
import { z } from "zod";
import { parseRuntimeEvent } from "./events.js";
import type { SQLiteRuntimeStore } from "./index.js";

export const pruneRequestSchema = z.object({
  key: z.string().min(1).max(128), before: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  maxRows: z.number().int().min(1).max(5000).default(500),
}).strict();
const receiptSchema = z.object({
  actor: z.string(), requestKeyHash: z.string(), before: z.iso.datetime(), afterSequence: z.number().int(), maxRows: z.number().int(),
  examined: z.number().int(), deleted: z.number().int(), examinedThrough: z.number().int(), deletedIdsHash: z.string(), createdAt: z.iso.datetime(),
}).strict();
const rowSchema = z.object({ sequence: z.number().int(), id: z.string(), schema_version: z.number(), run_id: z.string(), type: z.string(), source: z.string(), severity: z.string(), timestamp: z.string(), payload_json: z.string() });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class RuntimeRetention {
  constructor(private readonly store: SQLiteRuntimeStore) {}
  private get sql() { return this.store.database.sqlite; }

  prune(actor: string, input: unknown, now = new Date()) {
    z.string().min(1).max(256).parse(actor);
    const request = pruneRequestSchema.parse(input);
    if (Date.parse(request.before) > now.getTime()) throw new Error("Prune cutoff cannot be in the future");
    const actorHash = hash(actor); const requestKeyHash = hash(request.key);
    const intentHash = hash({ before: request.before, afterSequence: request.afterSequence, maxRows: request.maxRows });
    return this.sql.transaction(() => {
      const prior = this.sql.prepare("select intent_hash, receipt_json from runtime_prunes where actor=? and request_key=?").get(actorHash, requestKeyHash);
      if (prior) {
        const parsed = z.object({ intent_hash: z.string(), receipt_json: z.string() }).parse(prior);
        if (parsed.intent_hash !== intentHash) throw Object.assign(new Error("Prune key reused with different intent"), { statusCode: 409 });
        return receiptSchema.parse(JSON.parse(parsed.receipt_json));
      }
      // Bound examined candidates before eligibility filtering, including protected runs.
      const candidates = this.sql.prepare("select * from runtime_events where type='agent.output.delta' and sequence > ? order by sequence limit ?")
        .all(request.afterSequence, request.maxRows).map((row) => rowSchema.parse(row));
      const deletedIds: string[] = [];
      const terminal = new Map<string, boolean>();
      for (const row of candidates) {
        if (row.schema_version !== 1 || Date.parse(row.timestamp) >= Date.parse(request.before)) continue;
        try { this.parse(row); } catch { continue; }
        let eligible = terminal.get(row.run_id);
        if (eligible === undefined) { eligible = this.terminalBefore(row.run_id, request.before); terminal.set(row.run_id, eligible); }
        if (!eligible || this.referenced(row.run_id, row.id)) continue;
        this.sql.prepare("delete from runtime_events where sequence=? and id=? and type='agent.output.delta'").run(row.sequence, row.id);
        deletedIds.push(row.id);
      }
      const receipt = receiptSchema.parse({
        actor: this.store.redactor.text(actor), requestKeyHash, before: request.before, afterSequence: request.afterSequence, maxRows: request.maxRows,
        examined: candidates.length, deleted: deletedIds.length, examinedThrough: candidates.at(-1)?.sequence ?? request.afterSequence,
        deletedIdsHash: hash(deletedIds), createdAt: now.toISOString(),
      });
      this.sql.prepare("insert into runtime_prunes values (?, ?, ?, ?, ?)").run(actorHash, requestKeyHash, intentHash, this.store.redactor.json(receipt), now.toISOString());
      return receipt;
    }).immediate();
  }

  private parse(row: z.infer<typeof rowSchema>) {
    return parseRuntimeEvent({ id: row.id, runId: row.run_id, type: row.type, source: row.source, severity: row.severity, timestamp: row.timestamp, schemaVersion: row.schema_version, payload: JSON.parse(row.payload_json) });
  }

  private terminalBefore(runId: string, before: string): boolean {
    const rows = this.sql.prepare("select * from runtime_events where run_id=? and type in ('run.completed','run.failed','run.cancelled','run.skipped') order by sequence").all(runId).map((row) => rowSchema.parse(row));
    if (rows.length !== 1 || rows[0].schema_version !== 1 || Date.parse(rows[0].timestamp) >= Date.parse(before)) return false;
    try { this.parse(rows[0]); } catch { return false; }
    const start = this.sql.prepare("select 1 from runtime_events where run_id=? and type in ('run.queued','run.started') and sequence < ? limit 1").get(runId, rows[0].sequence);
    if (!start) return false;
    const pending = this.sql.prepare("select 1 from runtime_events where run_id=? and type in ('run.queued','run.started','run.cancel_requested') and sequence > ? limit 1").get(runId, rows[0].sequence);
    if (pending) return false;
    const job = this.sql.prepare("select state, finished_at from scheduled_jobs where run_id=?").get(runId);
    if (job) {
      const parsed = z.object({ state: z.string(), finished_at: z.string().nullable() }).parse(job);
      if (`run.${parsed.state}` !== rows[0].type || !parsed.finished_at || !Number.isFinite(Date.parse(parsed.finished_at)) || Date.parse(parsed.finished_at) >= Date.parse(before)) return false;
    }
    const open = this.sql.prepare(`select 1 from runtime_events s where s.run_id=? and s.type='observation.started'
      and not exists (select 1 from runtime_events c where c.run_id=s.run_id and c.type='observation.completed' and c.id='observation-complete:' || json_extract(s.payload_json,'$.operationId')) limit 1`).get(runId);
    return !open;
  }

  private referenced(runId: string, eventId: string): boolean {
    // Legacy eval evidence can be prose strings; conservatively retain any mention.
    for (const [table, column] of [["eval_reports", "evidence_json"], ["practice_versions", "definition_json"], ["practice_evaluations", "report_json"]] as const) {
      if (this.sql.prepare(`select 1 from ${table}, json_tree(${column}) j where j.type='text' and (instr(j.atom,?) > 0 or instr(j.atom,?) > 0) limit 1`).get(runId, eventId)) return true;
    }
    return false;
  }
}
