import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createFauxProvider, type Provider, type ProviderContext } from "@simple-coding-agent/ai";
import { SafeNetwork } from "@simple-coding-agent/security";
import { SQLiteRuntimeStore } from "../src/index.ts";
import { executeContentRun } from "../src/content-agent.ts";
import { contentTaskSchema, sourceReadSchema, type ContentTask } from "../src/content-contract.ts";
import { collectContentSource } from "../src/content-sources.ts";
import { z } from "zod";

const source = { id: "source", kind: "url", url: "https://source.test/page" } as const;
function fixture(sources: ContentTask["sources"] = [source]) {
  let fetches = 0;
  const store = new SQLiteRuntimeStore({ network: new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => {
    fetches++;
    const rss = '<rss version="2.0"><channel><title>News</title>' + (url.pathname === "/empty" ? "" : '<item><title>Release</title><link>https://source.test/story</link><description>Actual observed evidence about a new release.</description></item>') + '</channel></rss>';
    const body = sources.find((source) => source.url === url.href)?.kind === "rss" ? rss : "Actual observed evidence about a new release.";
    return { url: url.href, status: url.pathname === "/failed" ? 503 : 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(body) };
  } }) });
  const task = contentTaskSchema.parse({ id: "task", title: "Actual news", instruction: "Find new release news", sources });
  store.saveContentTask(task, 0);
  const admission = store.admitContentRun({ actor: "operator", key: "request", taskId: task.id, trigger: "manual" });
  return { store, task, runId: admission.runId, fetches: () => fetches };
}

function model(sourceIds: string[], options: { early?: boolean; forged?: boolean; duplicate?: boolean; failure?: boolean; wrongQuote?: boolean } = {}) {
  const contexts: ProviderContext[] = [];
  const baseline = createFauxProvider({ responses: [] }).provider;
  const provider: Provider = { ...baseline, stream(model, context, streamOptions) {
    contexts.push({ ...context, messages: structuredClone(context.messages), tools: context.tools?.map(({ execute: _execute, ...definition }) => structuredClone(definition)) });
    const messages = context.messages.filter((message) => message.role === "tool");
    if (!messages.length && !options.early) return createFauxProvider({ responses: [{ type: "success", content: [...sourceIds, ...(options.duplicate ? sourceIds : [])].map((sourceId) => ({ type: "tool_call", id: randomUUID(), name: "collect_source", arguments: { sourceId } })) }] }).provider.stream(model, context, streamOptions);
    if (options.failure) return createFauxProvider({ responses: [{ type: "failure", errorMessage: "controlled provider failure" }] }).provider.stream(model, context, streamOptions);
    const documents = messages.flatMap((message) => {
      if (message.isError) return [];
      const result = sourceReadSchema.parse(JSON.parse(message.content));
      return result.status === "ok" ? result.documents : [];
    });
    const document = documents[0];
    const items = document ? [{ documentId: options.forged ? randomUUID() : document.id, summary: "A new release was observed in the configured source.", reason: "Relevant to requested release updates.", score: 80, quotes: [options.wrongQuote ? "Invented unsupported evidence" : document.text.slice(0, 30)] }] : [];
    return createFauxProvider({ responses: [JSON.stringify({ items })], chunkSize: 200 }).provider.stream(model, context, streamOptions);
  } };
  return { provider, contexts };
}

test("R4 controlled Agent calls real collection, receives persisted evidence and commits cited output", async () => {
  const f = fixture();
  const m = model([source.id], { duplicate: true });
  try {
    await executeContentRun(f.store, f.runId, { providerFactory: () => m.provider });
    assert.equal(f.fetches(), 1);
    assert.equal(m.contexts.length, 2);
    assert.match(m.contexts[0].systemPrompt ?? "", /untrusted/);
    assert.match(m.contexts[0].messages[0].content.toString(), /Find new release news/);
    const result = f.store.readRunResult(f.runId);
    assert.equal(result?.outcome, "delivered");
    assert.equal(result?.items[0].citations?.[0].documentId, f.store.readSourceResults(f.runId).flatMap((read) => read.status === "ok" ? read.documents : [])[0].id);
    const events = await f.store.listEvents(f.runId);
    assert.equal(events.filter((event) => event.type === "agent.tool.completed").length, 2);
    assert.equal(events.filter((event) => event.type === "agent.model.completed").length, 2);
    assert.equal(events.some((event) => event.type === "source.read.completed"), true);
    assert.equal((await f.store.projectRun(f.runId)).status, "completed");
  } finally { f.store.database.sqlite.close(); }
});

for (const [label, settings, ids, expected] of [
  ["early final", { early: true }, ["source"], /every configured source/],
  ["foreign document", { forged: true }, ["source"], /unknown/],
  ["invented quote", { wrongQuote: true }, ["source"], /does not match/],
  ["unknown source", {}, ["other"], /outside/],
  ["provider failure", { failure: true }, ["source"], /controlled provider failure/],
] as const) {
  test(`R4 ${label} fails without receipt or delivery`, async () => {
    const f = fixture();
    try {
      await assert.rejects(executeContentRun(f.store, f.runId, { providerFactory: () => model([...ids], settings).provider }), expected);
      assert.equal((await f.store.projectRun(f.runId)).status, "failed");
      assert.equal(f.store.readRunResult(f.runId), undefined);
      assert.deepEqual(f.store.database.sqlite.prepare("select count(*) as count from content_deliveries").get(), { count: 0 });
      if (label === "unknown source") {
        assert.equal(f.fetches(), 0);
        const security = f.store.telemetry.operations(f.runId).find(({ start }) => start.details.kind === "security");
        assert.ok(security?.completion?.result.state === "finished" && security.completion.result.outcome === "denied");
        assert.equal(security.start.parentSpanId, f.store.telemetry.operations(f.runId).find(({ start }) => start.details.kind === "tool")?.start.spanId);
      }
    } finally { f.store.database.sqlite.close(); }
  });
}

test("R4 partial source failure is degraded; all-source failure is never successful", async () => {
  const failed = { ...source, id: "failed", url: "https://source.test/failed" };
  for (const sources of [[source, failed], [failed]]) {
    const f = fixture(sources);
    try {
      const work = executeContentRun(f.store, f.runId, { providerFactory: () => model(sources.map((source) => source.id)).provider });
      if (sources.length === 1) {
        await assert.rejects(work, /All configured sources failed/);
        assert.equal(f.store.readRunResult(f.runId), undefined);
      } else {
        await work;
        const completion = (await f.store.listEvents(f.runId)).find((event) => event.type === "run.completed");
        assert.equal(completion?.payload.quality, "degraded");
        assert.deepEqual(completion?.payload.failedSources, ["failed"]);
      }
    } finally { f.store.database.sqlite.close(); }
  }
});

test("R4 admission freezes config, retries preserve it and conflicting task updates fail", () => {
  const f = fixture();
  try {
    f.store.saveContentTask({ ...f.task, title: "Edited later" }, 1);
    assert.equal(f.store.readRunTask(f.runId)?.definition.title, "Actual news");
    const retry = f.store.admitContentRun({ actor: "operator", key: "request", taskId: "task", trigger: "manual" });
    assert.deepEqual(retry, { runId: f.runId, created: false });
    assert.throws(() => f.store.saveContentTask(f.task, 1), /revision changed/);
  } finally { f.store.database.sqlite.close(); }
});

for (const kind of ["rss", "browser"] as const) {
  test(`R4 ${kind} partial/all-source failure has the same delivery contract`, async () => {
    const good = { ...source, kind };
    const bad = { ...source, id: "failed", kind, url: "https://source.test/failed" };
    for (const sources of [[good, bad], [bad]]) {
      const f = fixture(sources);
      try {
        const work = executeContentRun(f.store, f.runId, { providerFactory: () => model(sources.map((source) => source.id)).provider, browser: async (_network, url) => {
          if (url.endsWith("/failed")) throw new Error("Browser source navigation failed");
          return { url, title: "Release", text: "Actual observed evidence about a new release.", links: [], blockedRequests: [] };
        } });
        if (sources.length === 1) { await assert.rejects(work, /All configured sources failed/); assert.equal(f.store.readRunResult(f.runId), undefined); }
        else { await work; assert.equal(f.store.readRunDetail(f.runId)?.events.find((event) => event.type === "run.completed")?.payload.quality, "degraded"); }
      } finally { f.store.database.sqlite.close(); }
    }
  });
}

test("R4 empty feed yields an explicit empty receipt; failed observation storage never reaches the model as evidence", async () => {
  const empty = fixture([{ ...source, kind: "rss", url: "https://source.test/empty" }]);
  try {
    await executeContentRun(empty.store, empty.runId, { providerFactory: () => model(["source"]).provider });
    assert.equal(empty.store.readRunResult(empty.runId)?.outcome, "no_new_items");
  } finally { empty.store.database.sqlite.close(); }
  const f = fixture();
  const m = model(["source"]);
  try {
    f.store.database.sqlite.exec("create trigger reject_source before insert on run_source_reads begin select raise(abort, 'observation storage failed'); end");
    await assert.rejects(executeContentRun(f.store, f.runId, { providerFactory: () => m.provider }), /every configured source/);
    assert.deepEqual(f.store.readSourceResults(f.runId), []);
    assert.equal(f.store.readRunResult(f.runId), undefined);
    assert.equal(m.contexts[1].messages.some((message) => message.role === "tool" && message.isError && message.content.includes("observation storage failed")), true);
  } finally { f.store.database.sqlite.close(); }
});

test("R4 abort prevents content commit and tool-budget exhaustion terminates the Agent cleanly", async () => {
  const f = fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(executeContentRun(f.store, f.runId, { providerFactory: () => model(["source"]).provider, signal: controller.signal }));
    assert.equal((await f.store.projectRun(f.runId)).status, "cancelled");
    assert.equal(f.fetches(), 0);
    assert.equal(f.store.readRunResult(f.runId), undefined);
  } finally { f.store.database.sqlite.close(); }
  const limited = fixture();
  try {
    limited.store.saveContentTask({ ...limited.task, limits: { ...limited.task.limits, maxToolCalls: 1 } }, 1);
    const admission = limited.store.admitContentRun({ actor: "operator", key: "limited", taskId: limited.task.id, trigger: "manual" });
    await assert.rejects(executeContentRun(limited.store, admission.runId, { providerFactory: () => model(["source"], { duplicate: true }).provider }), /maxToolCalls 1/);
    assert.equal(limited.store.readRunResult(admission.runId), undefined);
    assert.equal(limited.fetches(), 1);
  } finally { limited.store.database.sqlite.close(); }
});

test("R4 completion transaction rejects unreturned evidence and rolls back cited results on delivery failure", async () => {
  const f = fixture();
  try {
    await f.store.appendEvent(f.store.createEvent(f.runId, "run.started", { title: f.task.title, trigger: "manual", mode: "live" }));
    const read = f.store.saveSourceResult(f.runId, await collectContentSource({ runId: f.runId, source, limits: f.task.limits, network: f.store.network, redact: f.store.redactor.text }));
    if (read.status !== "ok") throw new Error("Fixture failed");
    const document = read.documents[0];
    const items = [{ id: f.store.contentId({ title: document.title, source: document.sourceId, url: document.url }), runId: f.runId, title: document.title, source: document.sourceId, url: document.url, summary: "A new release was observed.", reason: "Requested release news.", score: 80, status: "delivered" as const, evidence: [document.text], citations: [{ documentId: document.id, readUrl: document.readUrl, hash: document.hash, quote: document.text }], createdAt: new Date().toISOString() }];
    assert.throws(() => f.store.commitContentRun({ runId: f.runId, maxItems: 1, items }), /returned tool evidence/);
    assert.equal(f.store.readRunResult(f.runId), undefined);
    await f.store.appendEvent(f.store.createEvent(f.runId, "agent.tool.completed", { callId: "fixture-call", tool: "collect_source", isError: false, result: z.json().parse(read) }));
    f.store.database.sqlite.exec("create trigger reject_cited_delivery before insert on content_deliveries begin select raise(abort, 'delivery write failed'); end");
    assert.throws(() => f.store.commitContentRun({ runId: f.runId, maxItems: 1, items }), /delivery write failed/);
    assert.equal(f.store.database.sqlite.prepare("select * from run_content_results").all().length, 0);
    assert.equal(f.store.readRunResult(f.runId), undefined);
    assert.equal((await f.store.projectRun(f.runId)).status, "running");
  } finally { f.store.database.sqlite.close(); }
});
