import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { SQLiteRuntimeStore } from "@simple-coding-agent/runtime";
import { GuardedToolExecutor } from "../src/tool-executor.ts";
import { createAuthenticatedServer } from "./auth-fixture.ts";

test("R2.3 executor rejects unapproved, mismatched and expired grants; concurrent reuse executes once", async () => {
  const runtime = new SQLiteRuntimeStore();
  let now = 1000;
  let executions = 0;
  const executor = new GuardedToolExecutor({ runtime, now: () => now, tools: new Map([
    ["guarded_operation", { requiresApproval: true, parameters: z.object({ value: z.string(), count: z.number() }).strict(), execute: async () => { executions++; return "done"; } }],
  ]) });
  const operation = { runId: "run-one", tool: "guarded_operation", args: { value: "one", count: 1 }, actor: "owner" };
  try {
    for (const runId of ["run-one", "run-two"]) await runtime.appendEvent(runtime.createEvent(runId, "run.started", { title: "Test run", trigger: "manual" }));
    await assert.rejects(executor.execute(operation), /approval is required/);
    await assert.rejects(executor.requestApproval({ ...operation, runId: "nonexistent" }), /Run binding/);
    await assert.rejects(executor.execute({ ...operation, tool: "bash" }), /not registered/);
    const approval = await executor.requestApproval(operation);
    const approved = { ...operation, approvalId: approval.id };
    await assert.rejects(executor.execute(approved), /does not match/);
    await executor.approve(approval.id, "reviewer");
    for (const changed of [
      { ...approved, runId: "run-two" },
      { ...approved, args: { value: "changed", count: 1 } },
      { ...approved, actor: "other-operator" },
    ]) await assert.rejects(executor.execute(changed), /does not match/);
    assert.equal(executions, 0);
    const results = await Promise.allSettled([executor.execute({ ...approved, args: { count: 1, value: "one" } }), executor.execute(approved)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(executions, 1);
    assert.equal(executor.getApproval(approval.id).status, "consumed");
    assert.equal(executor.getApproval(approval.id).approved_by, "reviewer");
    const expired = await executor.requestApproval(operation);
    await executor.approve(expired.id, "reviewer");
    now += 300_001;
    await assert.rejects(executor.execute({ ...operation, approvalId: expired.id }), /expired/);
    assert.equal(executions, 1);
  } finally { runtime.database.sqlite.close(); }
});

test("R2.3 approved API operation clears actual memory once; forged approver is rejected", async () => {
  const { app, database, runtime, request } = await createAuthenticatedServer();
  try {
    await runtime.appendEvent(runtime.createEvent("run-clear", "run.started", { title: "Clear test", trigger: "manual" }));
    await request({ method: "POST", url: "/api/memory/entries", payload: { kind: "knowledge", content: "Retain until approved" } });
    const operation = { runId: "run-clear", tool: "memory_clear", args: { confirmation: "clear-memory" } };
    assert.equal((await request({ method: "POST", url: "/api/tools/execute", payload: operation })).statusCode, 403);
    const grant = await request({ method: "POST", url: "/api/security/approvals", payload: operation });
    assert.equal(grant.statusCode, 200);
    const id = grant.json().id;
    assert.equal((await request({ method: "POST", url: `/api/security/approvals/${id}/approve`, payload: { approver: "forged" } })).statusCode, 400);
    assert.equal((await request({ method: "POST", url: `/api/security/approvals/${id}/approve`, payload: {} })).statusCode, 200);
    const action = { method: "DELETE", url: "/api/memory", payload: { runId: operation.runId, approvalId: id } } as const;
    assert.equal((await request(action)).statusCode, 200);
    assert.equal(database.sqlite.prepare("select * from memory_entries").all().length, 0);
    assert.equal((await request(action)).statusCode, 403);
    const audit = await request({ url: "/api/security/audit" });
    assert.equal(audit.json().approvals.find((entry: { id: string }) => entry.id === id).status, "consumed");
  } finally { await app.close(); database.sqlite.close(); }
});
