import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteRuntimeStore, runContentPipeline } from "../src/index.ts";
import { practiceCompilerHash } from "../src/practice-rules.ts";
import { SQLiteRuntimeStore as BuiltRuntimeStore } from "@simple-coding-agent/runtime";

test("R6.3 empty and cleared memory never reinstall default user data", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    const empty = { interests: [], blockedTopics: [], sourceWeights: {}, recentFeedback: [], recentLessons: [], preferenceDiffs: [] };
    assert.deepEqual(await store.readMemory(), empty);
    await store.writeMemoryEntry({ kind: "preference", content: "SQLite", sourceTrust: "user" });
    await store.clearMemory();
    assert.deepEqual(await store.readMemory(), empty);
  } finally { store.database.sqlite.close(); }
});

test("R6.1 feedback retry does not stack and a changed signal replaces influence", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    const sources = [{ id: "fixture", kind: "mock" as const, items: [{ title: "SQLite durability", source: "fixture", url: "https://example.test/sqlite", text: "SQLite durability uses transactions." }] }];
    const [item] = await runContentPipeline(store, "before", { sources });
    await store.recordFeedback(item.id, "saved", "local", "first-action");
    const first = await store.readMemory();
    await store.recordFeedback(item.id, "saved");
    assert.deepEqual(await store.readMemory(), first);
    await store.recordFeedback(item.id, "not_interested");
    const latest = (await store.readMemory()).recentFeedback.filter((entry) => entry.itemId === item.id);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].signal, "not_interested");
    await store.recordFeedback(item.id, "saved", "local", "first-action");
    assert.equal((await store.readMemory()).recentFeedback.find((entry) => entry.itemId === item.id)?.signal, "not_interested");
    await assert.rejects(() => store.recordFeedback(item.id, "clicked", "local", "first-action"), /different intent/);
    await assert.rejects(() => store.recordFeedback("nonexistent", "saved"), /not found/i);
  } finally { store.database.sqlite.close(); }
});

test("R6.3 memory, search index and event commit atomically", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    store.database.sqlite.exec("create trigger fail_memory_event before insert on runtime_events when new.type = 'memory.preference.updated' begin select raise(abort, 'injected memory event failure'); end");
    await assert.rejects(() => store.writeMemoryEntry({ kind: "knowledge", content: "Atomic durable memory", sourceTrust: "user" }), /injected/);
    assert.equal((await store.exportMemory()).entries.length, 0);
    assert.deepEqual(await store.searchMemory("Atomic"), []);
  } finally { store.database.sqlite.close(); }
});

test("R6.2 plain text search safely handles punctuation and never invents hits", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    await store.writeMemoryEntry({ kind: "knowledge", content: "SQLite transactions support durable queues", sourceTrust: "user", metadata: { source: "operator note" } });
    assert.equal((await store.searchMemory('SQLite: "transactions')).length, 1);
    assert.deepEqual(await store.searchMemory('" : () *'), []);
    assert.deepEqual(await store.searchMemory("unmatchedword"), []);
  } finally { store.database.sqlite.close(); }
});

test("R6 preference history records replacements and removals atomically without fabricated feedback weights", async () => {
  const store = new SQLiteRuntimeStore();
  const changes = () => store.memory.read().preferenceDiffs.map(({ timestamp, ...change }) => change);
  try {
    store.memory.replacePreferences({ interests: ["SQLite"], sourceWeights: { feed: 2 } }, "owner");
    const before = store.memory.read();
    store.memory.replacePreferences({ interests: ["SQLite"], sourceWeights: { feed: 2 } }, "owner");
    assert.deepEqual(store.memory.read().preferenceDiffs, before.preferenceDiffs);
    store.memory.replacePreferences({ interests: ["Postgres"], sourceWeights: { feed: 0.5 } }, "owner");
    assert.ok(changes().some((entry) => entry.field === "interests" && entry.key === "SQLite" && entry.before === "SQLite" && entry.after === undefined));
    assert.ok(changes().some((entry) => entry.field === "sourceWeights" && entry.key === "feed" && entry.before === 2 && entry.after === 0.5));
    const prior = store.memory.read();
    store.database.sqlite.exec("create trigger fail_preferences before insert on runtime_events when new.type='memory.preference.updated' begin select raise(abort, 'preferences fault'); end");
    assert.throws(() => store.memory.replacePreferences({ interests: [] }, "owner"), /preferences fault/);
    assert.deepEqual(store.memory.read(), prior);
    store.database.sqlite.exec("drop trigger fail_preferences");
    const [item] = await runContentPipeline(store, "feedback-history", { sources: [{ id: "fixture", kind: "mock", items: [{ title: "History", source: "fixture", url: "https://example.test/history", text: "Preference history must preserve actual changes." }] }] });
    await store.recordFeedback(item.id, "saved", "owner");
    assert.deepEqual(store.memory.read().preferenceDiffs, prior.preferenceDiffs);
    store.memory.replacePreferences({ interests: [], sourceWeights: {} }, "owner");
    assert.ok(changes().some((entry) => entry.field === "sourceWeights" && entry.key === "feed" && entry.before === 0.5 && entry.after === undefined));
    await store.clearMemory();
    assert.deepEqual(changes(), []);
  } finally { store.database.sqlite.close(); }
});

test("R6.3 clear is atomic and fences unfinished work that captured old memory", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    await store.writeMemoryEntry({ kind: "knowledge", content: "SQLite durability", sourceTrust: "user" });
    await store.appendEvent(store.createEvent("in-flight", "run.started", { title: "Memory run", trigger: "manual" }));
    const captured = store.memory.capture("in-flight", "SQLite");
    store.database.sqlite.exec("create trigger fail_clear before insert on runtime_events when new.type='memory.preference.updated' begin select raise(abort, 'clear failed'); end");
    await assert.rejects(() => store.clearMemory(), /clear failed/);
    assert.equal((await store.searchMemory("SQLite")).length, 1);
    assert.doesNotThrow(() => store.assertRunExecutable("in-flight"));
    store.database.sqlite.exec("drop trigger fail_clear");
    await store.clearMemory();
    assert.throws(() => store.assertRunExecutable("in-flight"), /memory was cleared/);
    assert.deepEqual(store.memory.readContext("in-flight"), captured);
    assert.equal((await store.searchMemory("SQLite")).length, 0);
  } finally { store.database.sqlite.close(); }
});

test("R6 memory, feedback, practice release and frozen context survive reopening SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "r6-memory-"));
  const path = join(root, "memory.sqlite");
  let store = new SQLiteRuntimeStore({ path });
  try {
    store.memory.replacePreferences({ interests: ["SQLite"], sourceWeights: { source: 1.5 } }, "owner");
    store.memory.replacePreferences({ sourceWeights: { source: 2 } }, "owner");
    await store.writeMemoryEntry({ kind: "knowledge", sourceTrust: "user", content: "SQLite durable queues" }, "owner");
    const [item] = await runContentPipeline(store, "evidence", { sources: [{ id: "source", kind: "mock", items: [{ title: "SQLite news", source: "source", url: "https://example.test/sqlite", text: "SQLite durable queues use transactions." }] }] });
    const feedback = await store.recordFeedback(item.id, "saved", "owner", "saved-once");
    const candidate = store.practices.propose({ title: "Prioritize saved source", principle: "Use explicit user evidence", rules: [{ kind: "source_rank_bias", sourceId: "source", delta: 5 }], evidence: [{ kind: "feedback", feedbackId: feedback.id }] }, "owner");
    store.practices.review(candidate.id, "approved", "Confirmed feedback", "owner");
    const evaluation = store.practices.evaluate(candidate.id, "owner");
    store.database.sqlite.exec("create trigger fail_activation before insert on practice_activations begin select raise(abort, 'activation fault'); end");
    assert.throws(() => store.practices.activate(candidate.id, evaluation.id, 0, "owner"), /activation fault/);
    assert.equal(store.practices.state().version_id, null);
    assert.equal(store.practices.list().activations.length, 0);
    store.database.sqlite.exec("drop trigger fail_activation");
    store.practices.activate(candidate.id, evaluation.id, 0, "owner");
    await store.appendEvent(store.createEvent("context", "run.started", { title: "Context", trigger: "manual" }));
    const frozen = store.memory.capture("context", "SQLite");
    const before = await store.exportMemory();
    store.database.sqlite.close();
    store = new SQLiteRuntimeStore({ path });
    assert.deepEqual(await store.exportMemory(), before);
    assert.deepEqual(store.memory.readContext("context"), frozen);
    assert.equal(store.practices.active()?.id, candidate.id);
    assert.equal((await store.searchMemory("SQLite"))[0].source.actor, "owner");
    await store.recordFeedback(item.id, "not_interested", "owner");
    const stale = store.practices.evaluate(candidate.id, "owner");
    assert.equal(stale.report.passed, false);
    assert.equal(stale.report.checks.find((check) => check.name.startsWith("current-feedback:"))?.passed, false);
  } finally { if (store.database.sqlite.open) store.database.sqlite.close(); rmSync(root, { recursive: true, force: true }); }
});

test("R6.4 practice report fingerprint covers evaluator, executor and transaction enforcement", () => {
  const root = new URL("../src/", import.meta.url);
  const files = readdirSync(root).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts")).sort();
  for (const required of ["practices.ts", "content-agent.ts", "index.ts", "memory.ts", "practice-rules.ts"]) assert.ok(files.includes(required));
  const digest = (change?: string) => createHash("sha256").update(JSON.stringify(files.map((name) => ({ name, hash: createHash("sha256").update(readFileSync(new URL(name, root))).update(name === change ? "changed enforcement" : "").digest("hex") })))).digest("hex");
  assert.equal(practiceCompilerHash(), digest());
  assert.notEqual(practiceCompilerHash(), digest("index.ts"));
  assert.notEqual(practiceCompilerHash(), digest("practices.ts"));
});

test("R6.4 changed runtime build can revalidate the unchanged active practice explicitly", async () => {
  const store = new SQLiteRuntimeStore();
  try {
    const [item] = await runContentPipeline(store, "evidence", { sources: [{ id: "source", kind: "mock", items: [{ title: "A source", source: "source", url: "https://example.test/source", text: "A durable source contains useful technical details." }] }] });
    const candidate = store.practices.propose({ title: "Source diversity", principle: "Limit per-source deliveries", rules: [{ kind: "source_delivery_cap", maximum: 1 }], evidence: [{ kind: "run_result", runId: "evidence", contentId: item.id }] }, "owner");
    store.practices.review(candidate.id, "approved", "Verified source evidence", "owner");
    store.practices.activate(candidate.id, store.practices.evaluate(candidate.id, "owner").id, 0, "owner");
    const built = new BuiltRuntimeStore({ database: store.database });
    assert.throws(() => built.practices.active(), /evaluation for this build/);
    const report = built.practices.evaluate(candidate.id, "owner");
    assert.equal(report.report.passed, true);
    assert.equal(report.report.purpose, "build-revalidation");
    assert.notEqual(report.report.compilerHash, practiceCompilerHash());
    built.practices.activate(candidate.id, report.id, 1, "owner");
    assert.equal(built.practices.active()?.id, candidate.id);
    assert.equal(built.practices.list().activations.length, 2);
  } finally { store.database.sqlite.close(); }
});
