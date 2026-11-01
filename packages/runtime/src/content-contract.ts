import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const sourceUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Source URL must be HTTP(S) without credentials");
export const remoteSourceSchema = z.object({ id, kind: z.enum(["rss", "url", "browser"]), url: sourceUrlSchema }).strict();
export const contentTaskSchema = z.object({
  id, title: z.string().trim().min(1).max(160), instruction: z.string().trim().min(1).max(2000),
  sources: z.array(remoteSourceSchema).min(1).max(4).refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length, "Source IDs must be unique"),
  preferenceRef: z.literal("workspace").default("workspace"),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).default("deepseek-v4-pro"),
  limits: z.object({
    sourceTimeoutMs: z.number().int().min(50).max(30_000).default(10_000),
    runTimeoutMs: z.number().int().min(100).max(180_000).default(90_000),
    maxTurns: z.number().int().min(2).max(10).default(6),
    maxToolCalls: z.number().int().min(1).max(16).default(8),
    maxOutputTokens: z.number().int().min(128).max(8192).default(2048),
    maxDocumentsPerSource: z.number().int().min(1).max(5).default(5),
    maxTextChars: z.number().int().min(100).max(6000).default(4000),
    maxDeliveries: z.number().int().min(1).max(10).default(5),
  }).strict().prefault({}),
}).strict().refine((task) => task.limits.maxToolCalls >= task.sources.length, "Tool budget must permit all configured sources");
export type ContentTask = z.infer<typeof contentTaskSchema>;
export type RemoteSource = z.infer<typeof remoteSourceSchema>;
export type ContentTaskRecord = { definition: ContentTask; revision: number; updatedAt: string };

export const observedDocumentSchema = z.object({
  id: z.string().uuid(), runId: z.string().min(1), sourceId: id,
  title: z.string().min(1).max(500), url: sourceUrlSchema, readUrl: sourceUrlSchema,
  text: z.string().min(1).max(6000), hash: z.string().regex(/^[a-f0-9]{64}$/),
  collectedAt: z.iso.datetime(), truncated: z.boolean(), representation: z.enum(["feed_entry", "page_text"]),
}).strict();
export type ObservedDocument = z.infer<typeof observedDocumentSchema>;
export const sourceReadSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), sourceId: id, documents: z.array(observedDocumentSchema).max(5), durationMs: z.number().nonnegative() }).strict(),
  z.object({ status: z.literal("failed"), sourceId: id, code: z.enum(["timeout", "cancelled", "network", "http", "policy", "parse"]), message: z.string().max(1000), retryable: z.boolean(), durationMs: z.number().nonnegative() }).strict(),
]);
export type SourceRead = z.infer<typeof sourceReadSchema>;
export const contentCitationSchema = z.object({ documentId: z.string().uuid(), readUrl: sourceUrlSchema, quote: z.string().min(8).max(600), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ContentCitation = z.infer<typeof contentCitationSchema>;
export const summaryDraftSchema = z.object({ items: z.array(z.object({
  documentId: z.string().uuid(), summary: z.string().trim().min(10).max(2000),
  reason: z.string().trim().min(5).max(600), score: z.number().min(0).max(100),
  quotes: z.array(z.string().min(8).max(600)).min(1).max(3),
}).strict()).max(20) }).strict();

export function validateSummary(input: unknown, documents: readonly ObservedDocument[]) {
  const draft = summaryDraftSchema.parse(input);
  const seen = new Set<string>();
  return draft.items.map((item) => {
    const document = documents.find((candidate) => candidate.id === item.documentId);
    if (!document || seen.has(document.id)) throw new Error("Summary references unknown or duplicate evidence");
    seen.add(document.id);
    const citations = item.quotes.map((quote) => {
      if (!document.text.includes(quote)) throw new Error("Summary quote does not match observed content");
      return { documentId: document.id, readUrl: document.readUrl, quote, hash: document.hash } satisfies ContentCitation;
    });
    return { document, summary: item.summary, reason: item.reason, score: item.score, citations };
  });
}

export function mergeSimilarSummaries(items: ReturnType<typeof validateSummary>) {
  const groups: ReturnType<typeof validateSummary> = [];
  const words = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const canonicalUrl = (value: string) => { const url = new URL(value); url.hash = ""; return url.href; };
  for (const item of [...items].sort((left, right) => canonicalUrl(left.document.url).localeCompare(canonicalUrl(right.document.url)))) {
    const tokens = words(item.document.text);
    const existing = groups.find((group) => {
      if (canonicalUrl(group.document.url) === canonicalUrl(item.document.url)) return true;
      const other = words(group.document.text);
      if (Math.min(tokens.size, other.size) < 8) return false;
      const intersection = [...tokens].filter((word) => other.has(word)).length;
      return intersection / (tokens.size + other.size - intersection) >= 0.9;
    });
    if (!existing) { groups.push({ ...item, citations: [...item.citations] }); continue; }
    existing.score = Math.max(existing.score, item.score);
    for (const citation of item.citations) {
      if (!existing.citations.some((prior) => prior.documentId === citation.documentId && prior.quote === citation.quote)) existing.citations.push(citation);
    }
  }
  return groups;
}
