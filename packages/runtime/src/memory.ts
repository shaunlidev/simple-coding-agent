import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SQLiteRuntimeStore, MemoryEntryInput, MemoryState, MemoryExport } from "./index.js";
import { practiceSnapshotSchema, type PracticeSnapshot } from "./practice-rules.js";

export const feedbackSignalSchema = z.enum(["clicked", "saved", "not_interested", "dismissed"]);
const actorSchema = z.string().trim().min(1).max(128);
const metadataSchema = z.record(z.string(), z.json());
const entrySchema = z.object({
  id: z.string(), kind: z.enum(["preference", "blocked_topic", "source_weight", "lesson", "knowledge"]),
  source_trust: z.enum(["user", "system", "trusted_tool", "external"]), content: z.string(),
  metadata_json: z.string(), actor: z.string(), created_at: z.string(),
});
const feedbackRowSchema = z.object({ id: z.string(), item_id: z.string(), signal: feedbackSignalSchema, actor: z.string(), created_at: z.string() });
const preferenceChangeSchema = z.object({ field: z.enum(["interests", "blockedTopics", "sourceWeights"]), key: z.string(), before_json: z.string(), after_json: z.string(), created_at: z.string() });
const inputSchema = z.object({
  kind: entrySchema.shape.kind, sourceTrust: entrySchema.shape.source_trust,
  content: z.string().trim().min(1).max(4000), metadata: metadataSchema.default({}),
});

export type MemoryHit = {
  id: string; kind: z.infer<typeof entrySchema>["kind"]; content: string;
  metadata: z.infer<typeof metadataSchema>; source: { actor: string; trust: string; createdAt: string };
};
export type FeedbackState = z.infer<typeof feedbackRowSchema>;
export type RankingProfile = Pick<MemoryState, "interests" | "blockedTopics" | "sourceWeights">;
export type MemoryContext = {
  version: 1; epoch: number; capturedAt: string; profile: RankingProfile; feedback: FeedbackState[]; knowledge: MemoryHit[]; practice: PracticeSnapshot | null;
};
export type FrozenMemoryContext = { context: MemoryContext; hash: string };

export function guardMemoryWrite(input: MemoryEntryInput): void {
  if (input.sourceTrust === "external") throw new Error("Memory write denied: external sources cannot directly write long-term memory");
  if (/(ignore previous|system prompt|developer message|exfiltrate|jailbreak|write this to memory)/i.test(input.content)) throw new Error("Memory write denied: injection-like content");
}

function memoryError(message: string, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

export class RuntimeMemory {
  constructor(private readonly store: SQLiteRuntimeStore) {}

  private entries() {
    return this.store.database.sqlite.prepare("select * from memory_entries order by rowid").all().map((row) => entrySchema.parse(row));
  }

  feedback(): FeedbackState[] {
    return this.store.database.sqlite.prepare("select * from feedback order by created_at, id").all().map((row) => feedbackRowSchema.parse(row));
  }

  private changed(payload: Record<string, z.infer<typeof z.json>>) {
    this.store.appendEventSync(this.store.createEvent(`memory-${randomUUID()}`, "memory.preference.updated", payload, { source: "memory" }));
  }

  write(input: MemoryEntryInput, actor = "local") {
    return this.writeEntry(input, actor, true);
  }

  private writeEntry(input: MemoryEntryInput, actor: string, trackPreferences: boolean) {
    const parsed = inputSchema.parse(input);
    guardMemoryWrite(parsed);
    actor = this.store.redactor.identifier(actorSchema.parse(actor));
    const content = this.store.redactor.text(parsed.content);
    const metadata = this.store.redactor.record(parsed.metadata);
    if (JSON.stringify(metadata).length > 8192) throw memoryError("Memory metadata exceeds 8192 characters");
    if (["preference", "blocked_topic", "source_weight"].includes(parsed.kind) && content.length > 128) throw memoryError("Preference exceeds 128 characters");
    if (parsed.kind === "source_weight") {
      if (["__proto__", "prototype", "constructor"].includes(content)) throw memoryError("Invalid source identifier");
      metadata.weight = z.number().finite().min(0).max(3).parse(metadata.weight);
    }
    const metadataJson = JSON.stringify(metadata);
    const sql = this.store.database.sqlite;
    return sql.transaction(() => {
      const before = trackPreferences ? this.read() : undefined;
      const existing = sql.prepare("select * from memory_entries where kind = ? and content = ? and actor = ? order by rowid desc limit 1").get(parsed.kind, content, actor);
      if (existing) {
        const row = entrySchema.parse(existing);
        if (row.metadata_json === metadataJson && row.source_trust === parsed.sourceTrust) return { id: row.id, createdAt: row.created_at };
      }
      if (this.entries().length >= 1000) throw memoryError("Workspace memory capacity reached; remove entries before adding more", 409);
      const id = `mem-${randomUUID()}`;
      const createdAt = new Date().toISOString();
      sql.prepare("insert into memory_entries (id,kind,source_trust,content,metadata_json,created_at,actor) values (?,?,?,?,?,?,?)").run(id, parsed.kind, parsed.sourceTrust, content, metadataJson, createdAt, actor);
      sql.prepare("insert into memory_fts (id,kind,content,metadata_json) values (?,?,?,?)").run(id, parsed.kind, content, metadataJson);
      if (before) this.recordPreferenceChanges(before, this.read(), actor, createdAt);
      this.changed({ kind: parsed.kind, entryId: id, actor, detail: `Memory ${parsed.kind} saved` });
      return { id, createdAt };
    }).immediate();
  }

  recordFeedback(itemId: string, signal: z.infer<typeof feedbackSignalSchema>, actor = "local", requestKey?: string) {
    signal = feedbackSignalSchema.parse(signal);
    actor = this.store.redactor.identifier(actorSchema.parse(actor));
    this.store.redactor.identifier(itemId);
    if (requestKey) this.store.redactor.identifier(z.string().min(1).max(128).parse(requestKey));
    const sql = this.store.database.sqlite;
    return sql.transaction(() => {
      const intentHash = createHash("sha256").update(JSON.stringify({ itemId, signal })).digest("hex");
      const prior = requestKey ? sql.prepare("select intent_hash,receipt_json from feedback_requests where actor=? and request_key=?").get(actor, requestKey) : undefined;
      if (prior) {
        const row = z.object({ intent_hash: z.string(), receipt_json: z.string() }).parse(prior);
        if (row.intent_hash !== intentHash) throw memoryError("Feedback request key reused with different intent", 409);
        return z.object({ id: z.string(), changed: z.boolean() }).parse(JSON.parse(row.receipt_json));
      }
      const receipt = (value: { id: string; changed: boolean }) => {
        if (requestKey) sql.prepare("insert into feedback_requests values (?,?,?,?)").run(actor, requestKey, intentHash, JSON.stringify(value));
        return value;
      };
      if (!sql.prepare("select 1 from content_entities where id = ?").get(itemId)) throw memoryError("Feedback content not found", 404);
      const raw = sql.prepare("select * from feedback where actor = ? and item_id = ?").get(actor, itemId);
      const previous = raw ? feedbackRowSchema.parse(raw) : undefined;
      if (previous?.signal === signal) return receipt({ id: previous.id, changed: false });
      if (!previous && this.feedback().length >= 2000) throw memoryError("Workspace feedback capacity reached", 409);
      const record = { id: `fb-${randomUUID()}`, item_id: itemId, signal, actor, created_at: new Date().toISOString() };
      sql.prepare("insert into feedback (id,item_id,signal,actor,created_at) values (@id,@item_id,@signal,@actor,@created_at) on conflict(actor,item_id) do update set id=excluded.id, signal=excluded.signal, created_at=excluded.created_at").run(record);
      sql.prepare("insert into feedback_history (id,item_id,signal,actor,created_at) values (@id,@item_id,@signal,@actor,@created_at)").run(record);
      this.changed({ itemId, signal, actor, feedbackId: record.id, previous: previous?.signal ?? null, detail: `Feedback recorded: ${signal}` });
      return receipt({ id: record.id, changed: true });
    }).immediate();
  }

  replacePreferences(input: Partial<RankingProfile>, actor: string): RankingProfile {
    const patch = z.object({
      interests: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      blockedTopics: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      sourceWeights: z.record(z.string().min(1).max(128), z.number().finite().min(0).max(3)).optional(),
    }).strict().parse(input);
    actor = this.store.redactor.identifier(actorSchema.parse(actor));
    return this.store.database.sqlite.transaction(() => {
      const sql = this.store.database.sqlite;
      const before = this.read();
      for (const [field, kind] of [["interests", "preference"], ["blockedTopics", "blocked_topic"], ["sourceWeights", "source_weight"]] as const) {
        if (patch[field] === undefined) continue;
        sql.prepare("delete from memory_fts where id in (select id from memory_entries where kind=?)").run(kind);
        sql.prepare("delete from memory_entries where kind=?").run(kind);
        const values = field === "sourceWeights" ? Object.keys(patch.sourceWeights ?? {}) : patch[field] ?? [];
        for (const content of new Set(values)) this.writeEntry({ kind, content, sourceTrust: "user", ...(field === "sourceWeights" ? { metadata: { weight: patch.sourceWeights![content] } } : {}) }, actor, false);
      }
      const { interests, blockedTopics, sourceWeights } = this.read();
      const after = { interests, blockedTopics, sourceWeights };
      this.recordPreferenceChanges(before, after, actor, new Date().toISOString());
      if (Object.keys(patch).length) this.changed({ action: "preferences_replaced", actor, fields: Object.keys(patch) });
      return after;
    }).immediate();
  }

  private recordPreferenceChanges(before: RankingProfile, after: RankingProfile, actor: string, at: string) {
    const insert = this.store.database.sqlite.prepare("insert into memory_preference_changes values (?,?,?,?,?,?,?)");
    for (const field of ["interests", "blockedTopics", "sourceWeights"] as const) {
      const previous = field === "sourceWeights" ? before.sourceWeights : Object.fromEntries(before[field].map((key) => [key, key]));
      const current = field === "sourceWeights" ? after.sourceWeights : Object.fromEntries(after[field].map((key) => [key, key]));
      for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
        const from = Object.hasOwn(previous, key) ? previous[key] : null;
        const to = Object.hasOwn(current, key) ? current[key] : null;
        if (from !== to) insert.run(`diff-${randomUUID()}`, field, key, JSON.stringify(from), JSON.stringify(to), actor, at);
      }
    }
  }

  read(): MemoryState {
    const interests = new Set<string>();
    const blockedTopics = new Set<string>();
    const weights = new Map<string, number>();
    const recentLessons: MemoryState["recentLessons"] = [];
    const preferenceDiffs: MemoryState["preferenceDiffs"] = this.store.database.sqlite.prepare("select * from memory_preference_changes order by rowid desc limit 20").all().map((raw) => {
      const row = preferenceChangeSchema.parse(raw);
      const value = z.union([z.string(), z.number(), z.null()]);
      const before = value.parse(JSON.parse(row.before_json));
      const after = value.parse(JSON.parse(row.after_json));
      return { field: row.field, key: row.key, ...(before !== null ? { before } : {}), ...(after !== null ? { after } : {}), timestamp: row.created_at };
    });
    for (const row of this.entries()) {
      const metadata = metadataSchema.parse(JSON.parse(row.metadata_json));
      if (row.kind === "preference" || row.kind === "blocked_topic") {
        (row.kind === "preference" ? interests : blockedTopics).add(row.content);
      } else if (row.kind === "source_weight") {
        const weight = z.number().finite().min(0).max(3).safeParse(metadata.weight);
        if (weight.success) {
          weights.set(row.content, weight.data);
        }
      } else if (row.kind === "lesson") {
        recentLessons.unshift({ title: String(metadata.title ?? row.content), principle: row.content, evidence: String(metadata.evidence ?? `entry:${row.id}`), timestamp: row.created_at });
      }
    }
    const signals = this.feedback();
    return {
      interests: [...interests], blockedTopics: [...blockedTopics], sourceWeights: Object.fromEntries(weights),
      recentFeedback: signals.slice(-20).reverse().map((row) => ({ itemId: row.item_id, signal: row.signal, timestamp: row.created_at })),
      recentLessons: recentLessons.slice(0, 20), preferenceDiffs,
    };
  }

  search(query: string, knowledgeOnly = false): MemoryHit[] {
    const tokens = [...new Set(query.slice(0, 1000).match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 24);
    if (!tokens.length) return [];
    const expression = tokens.map((token) => `"${token}"`).join(" OR ");
    return this.store.database.sqlite.prepare("select m.* from memory_fts join memory_entries m on m.id = memory_fts.id where memory_fts match ? and (? = 0 or m.kind = 'knowledge') order by bm25(memory_fts), m.id limit 10").all(`content : (${expression})`, knowledgeOnly ? 1 : 0).map((raw) => {
      const row = entrySchema.parse(raw);
      return { id: row.id, kind: row.kind, content: row.content, metadata: metadataSchema.parse(JSON.parse(row.metadata_json)), source: { actor: row.actor, trust: row.source_trust, createdAt: row.created_at } };
    });
  }

  export(): MemoryExport {
    return { memory: this.read(), entries: this.entries().map((row) => ({ id: row.id, kind: row.kind, sourceTrust: row.source_trust, content: row.content, metadata: { ...metadataSchema.parse(JSON.parse(row.metadata_json)), actor: row.actor }, createdAt: row.created_at })) };
  }

  clear(actor = "local") {
    actor = this.store.redactor.identifier(actorSchema.parse(actor));
    this.store.database.sqlite.transaction(() => {
      this.store.practices.clear(actor);
      const affected = this.store.database.sqlite.prepare("select j.run_id,j.state from scheduled_jobs j join run_memory_contexts c on c.run_id=j.run_id where j.state in ('queued','running')").all().map((row) => z.object({ run_id: z.string(), state: z.enum(["queued", "running"]) }).parse(row));
      for (const run of affected) this.store.appendEventSync(this.store.createEvent(run.run_id, run.state === "queued" ? "run.cancelled" : "run.cancel_requested", { reason: "memory_cleared", actor }, { source: "memory" }));
      this.store.database.sqlite.exec("delete from memory_entries; delete from memory_preference_changes; delete from feedback; delete from feedback_history; delete from memory_fts; update memory_state set epoch=epoch+1 where id=1");
      this.changed({ action: "cleared", actor, detail: "Live memory and feedback cleared; historical run inputs and audit retained" });
    }).immediate();
  }

  capture(runId: string, query: string): FrozenMemoryContext {
    const sql = this.store.database.sqlite;
    return sql.transaction(() => {
      const existing = this.readContext(runId);
      if (existing) return existing;
      this.store.assertRunExecutable(runId);
      const { interests, blockedTopics, sourceWeights } = this.read();
      const epoch = z.object({ epoch: z.number().int() }).parse(sql.prepare("select epoch from memory_state where id=1").get()).epoch;
      const context: MemoryContext = { version: 1, epoch, capturedAt: new Date().toISOString(), profile: { interests, blockedTopics, sourceWeights }, feedback: this.feedback(), knowledge: this.search(query, true).slice(0, 5), practice: this.store.practices.active() };
      const json = JSON.stringify(context);
      const hash = createHash("sha256").update(json).digest("hex");
      sql.prepare("insert into run_memory_contexts values (?,?,?,?,?)").run(runId, json, hash, context.capturedAt, epoch);
      return { context, hash };
    }).immediate();
  }

  readContext(runId: string): FrozenMemoryContext | undefined {
    const raw = this.store.database.sqlite.prepare("select context_json, context_hash from run_memory_contexts where run_id = ?").get(runId);
    if (!raw) return undefined;
    const row = z.object({ context_json: z.string(), context_hash: z.string() }).parse(raw);
    if (createHash("sha256").update(row.context_json).digest("hex") !== row.context_hash) throw new Error("Memory context integrity mismatch");
    return { context: memoryContextSchema.parse(JSON.parse(row.context_json)), hash: row.context_hash };
  }
}

const memoryContextSchema = z.object({
  version: z.literal(1), epoch: z.number().int(), capturedAt: z.string(),
  profile: z.object({ interests: z.array(z.string()), blockedTopics: z.array(z.string()), sourceWeights: z.record(z.string(), z.number()) }),
  feedback: z.array(feedbackRowSchema),
  knowledge: z.array(z.object({ id: z.string(), kind: entrySchema.shape.kind, content: z.string(), metadata: metadataSchema, source: z.object({ actor: z.string(), trust: z.string(), createdAt: z.string() }) })),
  practice: practiceSnapshotSchema.nullable(),
});

function feedbackAdjustment(signal: z.infer<typeof feedbackSignalSchema>): number {
  return { saved: 18, clicked: 8, not_interested: -45, dismissed: -12 }[signal];
}

export function adjustContentRank(item: { id: string; source: string; title: string; text: string; score: number }, context: Pick<MemoryContext, "profile" | "feedback">) {
  const text = `${item.title} ${item.text}`.toLowerCase();
  const adjustments: Array<{ reason: string; delta: number }> = [];
  for (const interest of context.profile.interests) if (text.includes(interest.toLowerCase())) adjustments.push({ reason: `matches interest: ${interest}`, delta: 14 });
  for (const topic of context.profile.blockedTopics) if (text.includes(topic.toLowerCase())) adjustments.push({ reason: `blocked topic: ${topic}`, delta: -35 });
  const weight = Object.hasOwn(context.profile.sourceWeights, item.source) ? context.profile.sourceWeights[item.source] : 1;
  if (weight !== 1) adjustments.push({ reason: `source weight: ${weight}`, delta: Math.round((weight - 1) * 10) });
  const signals = context.feedback.filter((row) => row.item_id === item.id);
  if (signals.length) adjustments.push({ reason: signals.map((row) => `feedback: ${row.signal.replaceAll("_", " ")}`).join("; "), delta: Math.round(signals.reduce((sum, row) => sum + feedbackAdjustment(row.signal), 0) / signals.length) });
  const delta = Math.max(-80, Math.min(40, adjustments.reduce((sum, value) => sum + value.delta, 0)));
  return { baseScore: item.score, score: Math.max(0, Math.min(100, item.score + delta)), adjustment: delta, adjustments };
}
