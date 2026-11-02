import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticatedServer, viewerSecret } from "./auth-fixture.ts";

test("R6.3 memory API derives actor, rejects forged attribution and validates feedback targets", async () => {
  const { app, database, request, runtime } = await createAuthenticatedServer();
  try {
    const created = await request({ method: "POST", url: "/api/memory/entries", payload: { kind: "knowledge", content: "SQLite durable event processing" } });
    assert.equal(created.statusCode, 200);
    assert.deepEqual(database.sqlite.prepare("select actor, source_trust from memory_entries").get(), { actor: "owner", source_trust: "user" });
    const forged = await request({ method: "POST", url: "/api/memory/feedback", payload: { itemId: "absent", signal: "saved", actor: "system" } });
    assert.equal(forged.statusCode, 400);
    const missing = await request({ method: "POST", url: "/api/memory/feedback", payload: { itemId: "absent", signal: "saved" } });
    assert.equal(missing.statusCode, 404);
    const invalidWeight = await request({ method: "POST", url: "/api/memory/entries", payload: { kind: "source_weight", content: "source", metadata: { weight: 999 } } });
    assert.equal(invalidWeight.statusCode, 400);
    assert.equal((await runtime.readMemory()).recentFeedback.length, 0);
    assert.deepEqual((await runtime.readMemory()).sourceWeights, {});
    const query = await request({ method: "GET", url: `/api/memory/search?q=${encodeURIComponent('SQLite:"')}` });
    assert.equal(query.statusCode, 200);
    assert.equal(query.json().results[0].source.actor, "owner");
    const preferences = await request({ method: "PATCH", url: "/api/memory/preferences", payload: { interests: ["durable queues"], sourceWeights: { rss: 1.5 } } });
    assert.equal(preferences.statusCode, 200);
    assert.deepEqual((await runtime.readMemory()).interests, ["durable queues"]);
    assert.equal((await request({ method: "PATCH", url: "/api/memory/preferences", payload: { interests: [], actor: "forged" } })).statusCode, 400);
    assert.equal((await request({ method: "PATCH", url: "/api/memory/preferences", payload: { interests: [], sourceWeights: { rss: 8 } } })).statusCode, 400);
    assert.deepEqual((await runtime.readMemory()).interests, ["durable queues"]);
    const viewer = await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "guest", secret: viewerSecret } });
    const denied = await app.inject({ method: "PATCH", url: "/api/memory/preferences", payload: { interests: [] }, headers: { cookie: viewer.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "), "x-csrf-token": viewer.json().csrfToken } });
    assert.equal(denied.statusCode, 403);
  } finally { await app.close(); database.sqlite.close(); }
});

test("R6.4 API executes practice gates itself and rejects client success or trust claims", async () => {
  const { app, database, request } = await createAuthenticatedServer();
  try {
    const run = await request({ method: "POST", url: "/api/runs/run-now", payload: {} });
    const detail = await request({ method: "GET", url: `/api/runs/${run.json().runId}` });
    const item = detail.json().result.items[0];
    const feedback = await request({ method: "POST", url: "/api/memory/feedback", payload: { itemId: item.id, signal: "saved", requestKey: "practice-feedback" } });
    assert.equal(feedback.statusCode, 200);
    const payload = { title: "Learn from a saved result", principle: "Increase useful source coverage within a fixed bound", rules: [{ kind: "source_rank_bias", sourceId: item.source, delta: 5 }], evidence: [{ kind: "feedback", feedbackId: feedback.json().feedback.id }] };
    const forged = await request({ method: "POST", url: "/api/memory/practices", payload: { ...payload, sourceTrust: "system", actor: "system" } });
    assert.equal(forged.statusCode, 400);
    const proposed = await request({ method: "POST", url: "/api/memory/practices", payload });
    assert.equal(proposed.statusCode, 200);
    const id = proposed.json().id;
    assert.equal(proposed.json().actor, "owner");
    const early = await request({ method: "POST", url: `/api/memory/practices/${id}/evaluate`, payload: {} });
    assert.equal(early.statusCode, 409);
    const viewer = await app.inject({ method: "POST", url: "/api/auth/login", payload: { id: "guest", secret: viewerSecret } });
    const forbidden = await app.inject({ method: "POST", url: `/api/memory/practices/${id}/review`, payload: { decision: "approved", reason: "Viewer attempt" }, headers: { cookie: viewer.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "), "x-csrf-token": viewer.json().csrfToken } });
    assert.equal(forbidden.statusCode, 403);
    assert.equal((await request({ method: "POST", url: `/api/memory/practices/${id}/review`, payload: { decision: "approved", reason: "Checked the saved feedback evidence" } })).statusCode, 200);
    assert.equal((await request({ method: "POST", url: `/api/memory/practices/${id}/evaluate`, payload: { passed: true } })).statusCode, 400);
    const evaluation = await request({ method: "POST", url: `/api/memory/practices/${id}/evaluate`, payload: {} });
    assert.equal(evaluation.statusCode, 200);
    assert.equal(evaluation.json().report.passed, true);
    const activation = { evaluationId: evaluation.json().id, expectedRevision: 0, confirmation: "activate-practice" };
    assert.equal((await request({ method: "POST", url: `/api/memory/practices/${id}/activate`, payload: { ...activation, passed: true } })).statusCode, 400);
    assert.equal((await request({ method: "POST", url: `/api/memory/practices/${id}/activate`, payload: activation })).statusCode, 200);
    assert.equal((await request({ method: "POST", url: `/api/memory/practices/${id}/activate`, payload: activation })).statusCode, 409);
    const listed = await request({ method: "GET", url: "/api/memory/practices" });
    assert.equal(listed.json().state.version_id, id);
    assert.equal((await request({ method: "POST", url: "/api/memory/practices/rollback", payload: { expectedRevision: 1, confirmation: "rollback-practice" } })).statusCode, 200);
    assert.equal((await request({ method: "GET", url: "/api/memory/practices" })).json().state.version_id, null);
  } finally { await app.close(); database.sqlite.close(); }
});
