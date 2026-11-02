import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createFauxProvider, type Provider, type ProviderContext } from "@simple-coding-agent/ai";
import { SafeNetwork } from "@simple-coding-agent/security";
import { SQLiteRuntimeStore } from "../src/index.ts";
import { executeContentRun } from "../src/content-agent.ts";
import { contentTaskSchema, sourceReadSchema } from "../src/content-contract.ts";

function fixture(options: { rss?: boolean; oldFirst?: boolean } = {}) {
  let quoteCount = 1;
  let includeSecond = true;
  const task = contentTaskSchema.parse({ id: "research", title: "Database research", instruction: "Find SQLite and PostgreSQL release news", sources: [
    { id: "sqlite", kind: options.rss ? "rss" : "url", url: "https://source.test/sqlite" },
    ...(!options.rss ? [{ id: "postgres", kind: "url", url: "https://source.test/postgres" }] : []),
  ] });
  const rss = () => '<rss version="2.0"><channel><title>Database news</title><item><title>Transactions</title><link>https://source.test/transactions</link><description>SQLite release improves transactions and durable queues.</description></item>' + (includeSecond ? '<item><title>Replication</title><link>https://source.test/replication</link><description>PostgreSQL release improves replication and analytics.</description></item>' : "") + '</channel></rss>';
  const store = new SQLiteRuntimeStore({ network: new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => ({ url: url.href, status: 200, headers: { "content-type": options.rss ? "application/rss+xml" : "text/plain" }, body: new TextEncoder().encode(options.rss ? rss() : url.pathname === "/sqlite" ? "SQLite release improves transactions and durable queues." : "PostgreSQL release improves replication and analytics.") }) }) });
  store.saveContentTask(task, 0);
  const contexts: ProviderContext[] = [];
  const provider: Provider = { ...createFauxProvider({ responses: [] }).provider, stream(model, context, streamOptions) {
    contexts.push({ ...context, messages: structuredClone(context.messages) });
    const tools = context.messages.filter((message) => message.role === "tool");
    const responses = tools.length ? [JSON.stringify({ items: tools.flatMap((message) => {
      const result = sourceReadSchema.parse(JSON.parse(message.content));
      return result.status === "ok" ? result.documents.map((document) => ({ documentId: document.id, summary: document.text, reason: "Requested database update", score: options.oldFirst && document.url.endsWith("transactions") ? 90 : 50, quotes: Array.from({ length: quoteCount }, (_, index) => document.text.slice(index * 8, index * 8 + 24)) })) : [];
    }) })] : [{ type: "success" as const, content: task.sources.map((source) => ({ type: "tool_call" as const, id: randomUUID(), name: "collect_source", arguments: { sourceId: source.id } })) }];
    return createFauxProvider({ responses }).provider.stream(model, context, streamOptions);
  } };
  const run = async () => {
    const { runId } = store.admitContentRun({ actor: "operator", key: randomUUID(), taskId: task.id, trigger: "manual" });
    await executeContentRun(store, runId, { providerFactory: () => provider });
    return runId;
  };
  return { store, task, run, contexts, setQuoteCount: (count: number) => { quoteCount = count; }, setSecondItem: (enabled: boolean) => { includeSecond = enabled; } };
}

test("R6.1 real content executor applies feedback once to identical model scores", async () => {
  const f = fixture();
  try {
    const firstId = await f.run();
    const first = f.store.readRunResult(firstId)?.items ?? [];
    const saved = first.find((item) => item.source === "sqlite");
    const ignored = first.find((item) => item.source === "postgres");
    assert.ok(saved && ignored);
    assert.deepEqual(first.map((item) => item.score), [50, 50]);
    await f.store.recordFeedback(saved.id, "saved", "owner");
    await f.store.recordFeedback(saved.id, "saved", "owner");
    await f.store.recordFeedback(ignored.id, "not_interested", "owner");
    const secondId = await f.run();
    const next = f.store.readRunResult(secondId)?.items ?? [];
    assert.deepEqual(next.map((item) => [item.source, item.score]), [["sqlite", 68], ["postgres", 5]]);
    assert.ok(next[0].evidence.some((entry) => entry.includes("feedback: saved")));
    assert.equal(f.store.readRunResult(secondId)?.outcome, "no_new_items");
    assert.deepEqual(f.store.readRunResult(firstId)?.items.map((item) => item.score), [50, 50]);
  } finally { f.store.database.sqlite.close(); }
});

test("R6.2 exact retrieved note provenance reaches provider and frozen run context", async () => {
  const f = fixture();
  try {
    const note = await f.store.writeMemoryEntry({ kind: "knowledge", sourceTrust: "user", content: "SQLite WAL durability is relevant to our queue", metadata: { url: "https://sqlite.org/wal.html" } }, "owner");
    const runId = await f.run();
    const firstInput = f.contexts[0].messages[0];
    assert.equal(firstInput.role, "user");
    const prompt = JSON.parse(String(firstInput.content));
    assert.equal(prompt.memory.knowledge[0].id, note.id);
    assert.equal(prompt.memory.knowledge[0].source.actor, "owner");
    assert.equal(prompt.memory.knowledge[0].metadata.url, "https://sqlite.org/wal.html");
    assert.match(f.contexts[0].systemPrompt ?? "", /memory.*untrusted/i);
    const frozen = f.store.memory.readContext(runId);
    assert.ok(frozen);
    assert.deepEqual(prompt.memory.knowledge, frozen.context.knowledge);
    await f.store.clearMemory();
    assert.deepEqual(f.store.memory.readContext(runId), frozen);
    await f.run();
    assert.deepEqual(JSON.parse(String(f.contexts[2].messages[0].content)).memory.knowledge, []);
  } finally { f.store.database.sqlite.close(); }
});

test("R6.4 reviewed rule changes actual next-run ranking; queued context and rollback remain stable", async () => {
  const f = fixture();
  try {
    const first = f.store.readRunResult(await f.run());
    const item = first?.items.find((entry) => entry.source === "sqlite");
    assert.ok(item);
    await f.store.recordFeedback(item.id, "saved", "owner");
    const feedbackId = f.store.memory.feedback()[0].id;
    const queued = f.store.admitContentRun({ taskId: f.task.id, actor: "owner", key: "queued-before-activation", trigger: "manual" });
    const candidate = f.store.practices.propose({ title: "Favor SQLite coverage", principle: "Saved database coverage merits a small source preference", rules: [{ kind: "source_rank_bias", sourceId: "sqlite", delta: 10 }], evidence: [{ kind: "feedback", feedbackId }] }, "owner");
    assert.throws(() => f.store.practices.evaluate(candidate.id, "owner"), /reviewed/);
    f.store.practices.review(candidate.id, "approved", "Feedback direction is consistent", "owner");
    const evaluated = f.store.practices.evaluate(candidate.id, "owner");
    assert.equal(evaluated.report.passed, true);
    assert.equal(evaluated.report.evidenceKind, "deterministic-rule-regression");
    f.store.practices.activate(candidate.id, evaluated.id, 0, "owner");
    assert.equal(f.store.memory.readContext(queued.runId)?.context.practice, null);
    const activeRun = await f.run();
    assert.equal(f.store.readRunResult(activeRun)?.items.find((entry) => entry.source === "sqlite")?.score, 78);
    assert.equal(f.store.memory.readContext(activeRun)?.context.practice?.id, candidate.id);
    assert.ok(f.contexts.some((context) => JSON.parse(String(context.messages[0].content)).memory?.practice?.id === candidate.id));
    f.store.practices.rollback(1, "owner");
    assert.equal(f.store.readRunResult(await f.run())?.items.find((entry) => entry.source === "sqlite")?.score, 68);
    assert.equal(f.store.memory.readContext(activeRun)?.context.practice?.id, candidate.id);
    assert.throws(() => f.store.practices.activate(candidate.id, evaluated.id, 2, "owner"), /revision changed/);
  } finally { f.store.database.sqlite.close(); }
});

test("R6.4 failed, changed and cleared practice releases cannot activate", async () => {
  const f = fixture();
  try {
    const item = f.store.readRunResult(await f.run())?.items.find((entry) => entry.source === "sqlite");
    assert.ok(item);
    await f.store.recordFeedback(item.id, "not_interested", "owner");
    const feedbackId = f.store.memory.feedback()[0].id;
    const bad = f.store.practices.propose({ title: "Wrong direction", principle: "A deliberately invalid regression candidate", rules: [{ kind: "source_rank_bias", sourceId: "sqlite", delta: 10 }], evidence: [{ kind: "feedback", feedbackId }] }, "owner");
    f.store.practices.review(bad.id, "approved", "Run adversarial evaluation", "owner");
    const failed = f.store.practices.evaluate(bad.id, "owner");
    assert.equal(failed.report.passed, false);
    assert.throws(() => f.store.practices.activate(bad.id, failed.id, 0, "owner"), /evaluation failed/);
    const good = f.store.practices.propose({ title: "Respect rejected source", principle: "Reduce this source based on recorded rejection", rules: [{ kind: "source_rank_bias", sourceId: "sqlite", delta: -10 }], evidence: [{ kind: "feedback", feedbackId }], parentId: bad.id }, "owner");
    assert.throws(() => f.store.practices.activate(good.id, failed.id, 0, "owner"), /reviewed/);
    f.store.practices.review(good.id, "approved", "Consistent with evidence", "owner");
    const report = f.store.practices.evaluate(good.id, "owner");
    assert.equal(report.report.passed, true);
    await f.store.writeMemoryEntry({ kind: "preference", content: "Durable queues", sourceTrust: "user" });
    assert.throws(() => f.store.practices.activate(good.id, report.id, 0, "owner"), /Memory changed/);
    const updated = f.store.practices.evaluate(good.id, "owner");
    f.store.practices.activate(good.id, updated.id, 0, "owner");
    await f.store.clearMemory();
    assert.equal(f.store.practices.active(), null);
    assert.throws(() => f.store.practices.rollback(2, "owner"), /Cleared/);
    assert.throws(() => f.store.practices.evaluate(good.id, "owner"), /cleared memory epoch/);
  } finally { f.store.database.sqlite.close(); }
});

test("R6.4 quote rules are enforced by the actual executor", async () => {
  const f = fixture({ rss: true });
  try {
    const before = f.store.readRunResult(await f.run());
    assert.equal(before?.items.length, 2);
    assert.ok(before);
    const candidate = f.store.practices.propose({ title: "Stronger evidence", principle: "Use more supporting evidence", rules: [{ kind: "minimum_quotes", count: 2 }], evidence: [{ kind: "run_result", runId: before.runId, contentId: before.items[0].id }] }, "owner");
    f.store.practices.review(candidate.id, "approved", "Try bounded stricter evidence", "owner");
    const report = f.store.practices.evaluate(candidate.id, "owner");
    assert.equal(report.report.passed, true);
    f.store.practices.activate(candidate.id, report.id, 0, "owner");
    await assert.rejects(() => f.run(), /2 distinct supporting quotes/);
    f.setQuoteCount(2);
    const runId = await f.run();
    const result = f.store.readRunResult(runId);
    assert.equal(result?.items.filter((item) => item.status === "already_delivered").length, 2);
    assert.ok(result?.items.every((item) => item.citations?.length === 2));
    assert.match(f.contexts.at(-1)?.systemPrompt ?? "", /at least 2 distinct/);
  } finally { f.store.database.sqlite.close(); }
});

test("R6.4 source delivery cap never lets historical items starve a new item", async () => {
  const f = fixture({ rss: true, oldFirst: true });
  try {
    f.setSecondItem(false);
    const before = f.store.readRunResult(await f.run());
    assert.ok(before);
    const candidate = f.store.practices.propose({ title: "Limit source deliveries", principle: "Keep the inbox diverse", rules: [{ kind: "source_delivery_cap", maximum: 1 }], evidence: [{ kind: "run_result", runId: before.runId, contentId: before.items[0].id }] }, "owner");
    f.store.practices.review(candidate.id, "approved", "One new item per source", "owner");
    const evaluation = f.store.practices.evaluate(candidate.id, "owner");
    f.store.practices.activate(candidate.id, evaluation.id, 0, "owner");
    f.setSecondItem(true);
    const next = f.store.readRunResult(await f.run());
    assert.equal(next?.items[0].score, 90);
    assert.equal(next?.items[0].status, "already_delivered");
    assert.equal(next?.items[1].status, "delivered");
    assert.equal(next?.outcome, "delivered");
    assert.equal(next?.deliveries.length, 1);
  } finally { f.store.database.sqlite.close(); }
});

test("R6.4 rollback re-evaluates current evidence and preserves a failed attempt", async () => {
  const f = fixture();
  try {
    const runId = await f.run();
    const item = f.store.readRunResult(runId)?.items.find((entry) => entry.source === "sqlite");
    assert.ok(item);
    const feedback = await f.store.recordFeedback(item.id, "saved", "owner");
    const first = f.store.practices.propose({ title: "Saved source", principle: "Use feedback", rules: [{ kind: "source_rank_bias", sourceId: "sqlite", delta: 10 }], evidence: [{ kind: "feedback", feedbackId: feedback.id }] }, "owner");
    f.store.practices.review(first.id, "approved", "Confirmed", "owner");
    f.store.practices.activate(first.id, f.store.practices.evaluate(first.id, "owner").id, 0, "owner");
    const second = f.store.practices.propose({ title: "Diversity", principle: "Limit source deliveries", rules: [{ kind: "source_delivery_cap", maximum: 1 }], evidence: [{ kind: "run_result", runId, contentId: item.id }] }, "owner");
    f.store.practices.review(second.id, "approved", "Confirmed", "owner");
    f.store.practices.activate(second.id, f.store.practices.evaluate(second.id, "owner").id, 1, "owner");
    await f.store.recordFeedback(item.id, "not_interested", "owner");
    assert.throws(() => f.store.practices.rollback(2, "owner"), /evaluation failed/);
    assert.equal(f.store.practices.active()?.id, second.id);
    assert.equal(f.store.practices.list().evaluations[0].report.passed, false);
    assert.equal(f.store.practices.list().evaluations[0].report.versionId, first.id);
  } finally { f.store.database.sqlite.close(); }
});
