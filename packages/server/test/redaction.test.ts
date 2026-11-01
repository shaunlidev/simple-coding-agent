import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticatedServer } from "./auth-fixture.ts";

test("R2.5 configured secrets and secret fields never enter persisted events, memory, FTS, audit or content", async () => {
  const secret = "opaque-provider-credential-13579-abcdefgh";
  const fieldSecret = "field-only-sensitive-value";
  const { app, database, runtime, request } = await createAuthenticatedServer({ env: { DEEPSEEK_API_KEY: secret } });
  try {
    await runtime.appendEvent(runtime.createEvent("redaction-run", "run.started", { title: secret, detail: secret, nested: { password: fieldSecret }, inputTokens: 14 }));
    await request({ method: "POST", url: "/api/memory/entries", payload: { kind: "knowledge", content: `Useful knowledge ${secret}`, metadata: { authorization: fieldSecret } } });
    await runtime.recordSecurityAudit({ action: "redaction_probe", severity: "warning", message: secret });
    await runtime.saveEvalReport({ id: "redaction-eval", name: secret, status: "failed", score: 0, evidence: secret, evidenceData: { credential: fieldSecret } });
    await runtime.insertContentItems([{ id: "redaction-content", runId: "redaction-run", title: secret, source: "fixture", summary: secret, reason: secret, evidence: [secret], score: 1, status: "delivered", createdAt: new Date().toISOString() }]);
    for (const table of ["runtime_events", "memory_entries", "memory_fts", "security_audit", "eval_reports", "content_items"]) {
      const data = JSON.stringify(database.sqlite.prepare(`select * from ${table}`).all());
      assert.equal(data.includes(secret), false, `${table} contains a configured secret`);
      assert.equal(data.includes(fieldSecret), false, `${table} contains a structured secret field`);
    }
    for (const url of ["/api/snapshot", "/api/memory/export", "/api/security/audit", "/api/events/stream?once=1", "/api/runs/redaction-run"]) {
      const response = await request({ url });
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.body.includes(secret), false, url);
      assert.equal(response.body.includes(fieldSecret), false, url);
    }
    assert.equal((await runtime.listEvents("redaction-run"))[0]?.payload.inputTokens, 14);
  } finally { await app.close(); database.sqlite.close(); }
});

test("R2.5 request logs and error responses redact configured secrets without dropping audit context", async () => {
  const secret = "opaque-provider-log-probe-abcdefghijk";
  const logs: string[] = [];
  const { app, database, request } = await createAuthenticatedServer({ env: { DEEPSEEK_API_KEY: secret }, logger: true, logStream: { write: (message) => { logs.push(message); } } });
  try {
    const response = await request({ method: "PATCH", url: `/api/schedules/${secret}`, payload: { enabled: false } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.includes(secret), false);
    assert.match(response.body, /Secret-like/);
    assert.ok(logs.length > 0);
    assert.match(logs.join(""), /REDACTED/);
    assert.equal(logs.join("").includes(secret), false);
    assert.equal(logs.join("").includes("test-operator-credential"), false);
    const audit = await request({ url: "/api/security/audit" });
    assert.match(audit.body, /owner/);
    assert.match(audit.body, /requestId/);
  } finally { await app.close(); database.sqlite.close(); }
});
