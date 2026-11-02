import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SQLiteRuntimeStore } from "./index.js";
import { evaluatePracticeRules, practiceCompilerHash, practiceRulesSchema, type PracticeSnapshot } from "./practice-rules.js";

const identifier = z.string().min(1).max(256);
export const practiceEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run_result"), runId: identifier, contentId: identifier }).strict(),
  z.object({ kind: z.literal("feedback"), feedbackId: identifier }).strict(),
]);
export const practiceProposalSchema = z.object({
  title: z.string().trim().min(1).max(160), principle: z.string().trim().min(1).max(2000),
  rules: practiceRulesSchema, evidence: z.array(practiceEvidenceSchema).min(1).max(10), parentId: identifier.nullable().default(null),
}).strict();
const resolvedEvidenceSchema = z.object({ reference: practiceEvidenceSchema, source: z.string(), contentId: z.string(), runId: z.string(), summary: z.string(), signal: z.enum(["clicked", "saved", "not_interested", "dismissed"]).optional(), actor: z.string().optional(), hash: z.string() });
const definitionSchema = practiceProposalSchema.extend({ evidence: z.array(resolvedEvidenceSchema) });
const versionRowSchema = z.object({ id: z.string(), definition_json: z.string(), definition_hash: z.string(), epoch: z.number(), actor: z.string(), created_at: z.string() });
const reviewSchema = z.object({ id: z.string(), version_id: z.string(), decision: z.enum(["approved", "rejected"]), actor: z.string(), reason: z.string(), created_at: z.string() });
const stateSchema = z.object({ version_id: z.string().nullable(), revision: z.number().int() });
const reportSchema = z.object({
  versionId: z.string(), versionHash: z.string(), reviewId: z.string(), baselineRevision: z.number(), baselineId: z.string().nullable(), epoch: z.number(), memoryHash: z.string(), compilerHash: z.string(),
  purpose: z.enum(["candidate", "build-revalidation"]),
  evidenceKind: z.literal("deterministic-rule-regression"), passed: z.boolean(), checks: z.array(z.object({ name: z.string(), passed: z.boolean(), expected: z.string(), actual: z.string() })),
});
const activationSchema = z.object({ id: z.string(), revision: z.number(), from_id: z.string().nullable(), to_id: z.string().nullable(), evaluation_id: z.string().nullable(), action: z.enum(["activate", "rollback", "clear"]), actor: z.string(), created_at: z.string() });

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function conflict(message: string) { return Object.assign(new Error(message), { statusCode: 409 }); }

export class RuntimePractices {
  constructor(private readonly store: SQLiteRuntimeStore) {}
  private get sql() { return this.store.database.sqlite; }
  private actor(actor: string) { return this.store.redactor.identifier(z.string().trim().min(1).max(128).parse(actor)); }
  private epoch() { return z.object({ epoch: z.number() }).parse(this.sql.prepare("select epoch from memory_state where id=1").get()).epoch; }
  private memoryHash() { return hash({ epoch: this.epoch(), entries: this.store.memory.export(), feedback: this.store.memory.feedback() }); }
  state() { return stateSchema.parse(this.sql.prepare("select version_id, revision from practice_state where id=1").get()); }
  private event(action: string, payload: Record<string, unknown>) { this.store.appendEventSync(this.store.createEvent(`practice-${randomUUID()}`, "memory.practice.changed", { action, ...payload }, { source: "practices" })); }

  version(id: string) {
    const raw = this.sql.prepare("select * from practice_versions where id=?").get(id);
    if (!raw) throw Object.assign(new Error("Practice version not found"), { statusCode: 404 });
    const row = versionRowSchema.parse(raw);
    const definition = definitionSchema.parse(JSON.parse(row.definition_json));
    if (hash(definition) !== row.definition_hash) throw conflict("Practice version integrity mismatch");
    return { id: row.id, hash: row.definition_hash, epoch: row.epoch, actor: row.actor, createdAt: row.created_at, definition };
  }

  private resolveEvidence(reference: z.infer<typeof practiceEvidenceSchema>): z.infer<typeof resolvedEvidenceSchema> {
    let contentId: string;
    let runId: string | undefined;
    let feedback: { signal: "clicked" | "saved" | "not_interested" | "dismissed"; actor: string } | undefined;
    if (reference.kind === "run_result") { contentId = reference.contentId; runId = reference.runId; }
    else {
      const row = this.sql.prepare("select item_id, signal, actor from feedback_history where id=?").get(reference.feedbackId);
      if (!row) throw conflict("Practice feedback evidence not found");
      const value = z.object({ item_id: z.string(), signal: resolvedEvidenceSchema.shape.signal.unwrap(), actor: z.string() }).parse(row);
      if (value.actor === "legacy") throw conflict("Legacy feedback needs explicit reattribution before practice use");
      contentId = value.item_id; feedback = { signal: value.signal, actor: value.actor };
    }
    const raw = runId
      ? this.sql.prepare("select r.* from run_content_results r join run_receipts p on p.run_id=r.run_id where r.run_id=? and r.content_id=? and p.provenance<>'legacy'").get(runId, contentId)
      : this.sql.prepare("select r.* from run_content_results r join run_receipts p on p.run_id=r.run_id where r.content_id=? and p.provenance<>'legacy' order by r.rowid desc limit 1").get(contentId);
    if (!raw) throw conflict("Practice run result evidence not found");
    const row = z.object({ content_id: z.string(), run_id: z.string(), source: z.string(), summary: z.string() }).parse(raw);
    return { reference, source: row.source, contentId: row.content_id, runId: row.run_id, summary: row.summary, ...feedback, hash: hash(raw) };
  }

  propose(input: unknown, actor: string) {
    const proposal = practiceProposalSchema.parse(this.store.redactor.value(practiceProposalSchema.parse(input)));
    actor = this.actor(actor);
    return this.sql.transaction(() => {
      if (proposal.parentId) this.version(proposal.parentId);
      const definition = { ...proposal, evidence: proposal.evidence.map((reference) => this.resolveEvidence(reference)) };
      const id = randomUUID();
      this.sql.prepare("insert into practice_versions values (?,?,?,?,?,?)").run(id, JSON.stringify(definition), hash(definition), this.epoch(), actor, new Date().toISOString());
      this.event("proposed", { versionId: id, versionHash: hash(definition), actor });
      return this.version(id);
    }).immediate();
  }

  review(versionId: string, decision: "approved" | "rejected", reason: string, actor: string) {
    actor = this.actor(actor);
    decision = reviewSchema.shape.decision.parse(decision);
    reason = this.store.redactor.text(z.string().trim().min(1).max(2000).parse(reason));
    return this.sql.transaction(() => {
      if (this.version(versionId).epoch !== this.epoch()) throw conflict("Practice belongs to a cleared memory epoch");
      if (this.sql.prepare("select 1 from practice_reviews where version_id=?").get(versionId)) throw conflict("Practice review is immutable; propose a new version");
      const id = randomUUID();
      this.sql.prepare("insert into practice_reviews values (?,?,?,?,?,?)").run(id, versionId, decision, actor, reason, new Date().toISOString());
      this.event("reviewed", { versionId, reviewId: id, decision, actor });
      return reviewSchema.parse(this.sql.prepare("select * from practice_reviews where id=?").get(id));
    }).immediate();
  }

  private approved(versionId: string) {
    const raw = this.sql.prepare("select * from practice_reviews where version_id=?").get(versionId);
    if (!raw) throw conflict("Practice must be reviewed before evaluation or activation");
    const review = reviewSchema.parse(raw);
    if (review.decision !== "approved") throw conflict("Practice review rejected");
    return review;
  }

  evaluate(versionId: string, actor: string) {
    actor = this.actor(actor);
    return this.sql.transaction(() => {
      const version = this.version(versionId);
      if (version.epoch !== this.epoch()) throw conflict("Practice belongs to a cleared memory epoch");
      const review = this.approved(versionId);
      const state = this.state();
      const checks = evaluatePracticeRules(version.definition.rules);
      for (const evidence of version.definition.evidence) {
        if (evidence.reference.kind !== "feedback") continue;
        const current = this.sql.prepare("select 1 from feedback where id=?").get(evidence.reference.feedbackId) !== undefined;
        checks.push({ name: `current-feedback:${evidence.reference.feedbackId}`, passed: current, expected: "evidence is the effective feedback choice", actual: current ? "current" : "superseded" });
      }
      for (const rule of version.definition.rules) {
        if (rule.kind !== "source_rank_bias") continue;
        const signals = version.definition.evidence.filter((entry) => entry.source === rule.sourceId && entry.signal);
        const support = signals.some((entry) => rule.delta > 0 ? entry.signal === "saved" || entry.signal === "clicked" : entry.signal === "not_interested" || entry.signal === "dismissed");
        const contradicts = signals.some((entry) => rule.delta < 0 ? entry.signal === "saved" || entry.signal === "clicked" : entry.signal === "not_interested" || entry.signal === "dismissed");
        checks.push({ name: `evidence-direction:${rule.sourceId}`, passed: support && !contradicts, expected: "attributed feedback supports bias direction without contradictory evidence", actual: signals.map((entry) => entry.signal).join(",") || "no supporting feedback" });
      }
      const purpose = state.version_id === versionId ? "build-revalidation" as const : "candidate" as const;
      const report = { versionId, versionHash: version.hash, reviewId: review.id, baselineRevision: state.revision, baselineId: state.version_id, epoch: this.epoch(), memoryHash: this.memoryHash(), compilerHash: practiceCompilerHash(), purpose, evidenceKind: "deterministic-rule-regression" as const, passed: checks.every((check) => check.passed), checks };
      const id = randomUUID();
      this.sql.prepare("insert into practice_evaluations values (?,?,?,?,?)").run(id, versionId, JSON.stringify(report), hash(report), new Date().toISOString());
      this.event("evaluated", { versionId, evaluationId: id, passed: report.passed, actor });
      return { id, report };
    }).immediate();
  }

  private report(id: string) {
    const raw = this.sql.prepare("select report_json,report_hash from practice_evaluations where id=?").get(id);
    if (!raw) throw conflict("Practice evaluation not found");
    const row = z.object({ report_json: z.string(), report_hash: z.string() }).parse(raw);
    const report = reportSchema.parse(JSON.parse(row.report_json));
    if (hash(report) !== row.report_hash) throw conflict("Practice evaluation integrity mismatch");
    return report;
  }

  private validateActivation(versionId: string, evaluationId: string, expectedRevision: number) {
    const version = this.version(versionId);
    const review = this.approved(versionId);
    const report = this.report(evaluationId);
    const state = this.state();
    if (!report.passed || !report.checks.length || report.checks.some((check) => !check.passed)) throw conflict("Practice evaluation failed");
    if (report.versionId !== versionId || report.versionHash !== version.hash || report.reviewId !== review.id || report.compilerHash !== practiceCompilerHash()) throw conflict("Practice evaluation binding changed");
    if (report.epoch !== this.epoch() || version.epoch !== this.epoch() || report.memoryHash !== this.memoryHash()) throw conflict("Memory changed since practice evaluation");
    if (state.revision !== expectedRevision || report.baselineRevision !== state.revision || report.baselineId !== state.version_id) throw conflict("Practice active revision changed; evaluate again");
  }

  activate(versionId: string, evaluationId: string, expectedRevision: number, actor: string) {
    actor = this.actor(actor);
    return this.sql.transaction(() => {
      this.validateActivation(versionId, evaluationId, expectedRevision);
      return this.transition(versionId, evaluationId, "activate", actor);
    }).immediate();
  }

  private transition(versionId: string | null, evaluationId: string | null, action: "activate" | "rollback" | "clear", actor: string) {
    const previous = this.state();
    const revision = previous.revision + 1;
    const id = randomUUID();
    this.sql.prepare("update practice_state set version_id=?,revision=? where id=1").run(versionId, revision);
    this.sql.prepare("insert into practice_activations values (?,?,?,?,?,?,?,?)").run(id, revision, previous.version_id, versionId, evaluationId, action, actor, new Date().toISOString());
    this.event(action, { versionId, previousVersionId: previous.version_id, revision, evaluationId, actor });
    return { id, ...this.state() };
  }

  rollback(expectedRevision: number, actor: string) {
    actor = this.actor(actor);
    const target = this.sql.transaction(() => {
      const current = this.state();
      if (current.revision !== expectedRevision) throw conflict("Practice active revision changed");
      const raw = this.sql.prepare("select * from practice_activations where revision=?").get(current.revision);
      if (!raw) throw conflict("No practice activation to roll back");
      const previous = activationSchema.parse(raw);
      if (previous.action === "clear") throw conflict("Cleared practices cannot be restored by rollback");
      if (previous.from_id) {
        const target = this.version(previous.from_id);
        if (target.epoch !== this.epoch()) throw conflict("Rollback target belongs to cleared memory");
        this.approved(target.id);
      }
      return previous.from_id;
    }).immediate();
    // Keep a failed rollback evaluation as evidence rather than rolling its report back too.
    const evaluation = target ? this.evaluate(target, actor) : undefined;
    return this.sql.transaction(() => {
      if (this.state().revision !== expectedRevision) throw conflict("Practice active revision changed");
      if (target && evaluation) this.validateActivation(target, evaluation.id, expectedRevision);
      return this.transition(target, evaluation?.id ?? null, "rollback", actor);
    }).immediate();
  }

  clear(actor: string) { return this.transition(null, null, "clear", this.actor(actor)); }

  active(): PracticeSnapshot | null {
    const state = this.state();
    if (!state.version_id) return null;
    const version = this.version(state.version_id);
    if (version.epoch !== this.epoch()) throw conflict("Active practice epoch is stale");
    const raw = this.sql.prepare("select evaluation_id from practice_activations where revision=?").get(state.revision);
    const evaluationId = z.object({ evaluation_id: z.string() }).parse(raw).evaluation_id;
    if (this.report(evaluationId).compilerHash !== practiceCompilerHash()) throw conflict("Active practice requires evaluation for this build");
    return { id: version.id, hash: version.hash, rules: version.definition.rules, compilerHash: practiceCompilerHash() };
  }

  list() {
    return {
      state: this.state(),
      versions: this.sql.prepare("select id from practice_versions order by rowid desc limit 100").all().map((row) => this.version(z.object({ id: z.string() }).parse(row).id)),
      reviews: this.sql.prepare("select * from practice_reviews order by rowid desc limit 100").all().map((row) => reviewSchema.parse(row)),
      evaluations: this.sql.prepare("select id from practice_evaluations order by rowid desc limit 100").all().map((row) => { const id = z.object({ id: z.string() }).parse(row).id; return { id, report: this.report(id) }; }),
      activations: this.sql.prepare("select * from practice_activations order by revision desc limit 100").all().map((row) => activationSchema.parse(row)),
    };
  }
}
