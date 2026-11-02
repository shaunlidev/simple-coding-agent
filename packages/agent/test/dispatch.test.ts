import assert from "node:assert/strict";
import test from "node:test";
import { createFauxProvider, type ToolDefinition } from "@simple-coding-agent/ai";
import { Agent, type AgentDispatch } from "../src/index.ts";

const tool: ToolDefinition = { name: "read", description: "Read fixture", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: () => "evidence" };
const sequence = () => createFauxProvider({ responses: [{ type: "success", content: [{ type: "tool_call", id: "read-1", name: "read", arguments: {} }] }, "done"] });
const direct: AgentDispatch = { model: (_call, invoke) => invoke(), tool: (_call, invoke) => invoke() };
function gate() { let release = () => {}; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("R7.4 model preflight denial prevents provider dispatch", async () => {
  const fixture = sequence();
  const agent = new Agent({ provider: fixture.provider, tools: [tool], dispatch: { ...direct, model: async () => { throw new Error("budget denied"); } } });
  const result = await agent.prompt("research");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /budget denied/);
  assert.equal(fixture.pendingResponses(), 2);
});

test("R7.4 model settlement is an awaited barrier before tool execution", { timeout: 5000 }, async () => {
  const fixture = sequence(); const arrived = gate(); const settle = gate(); let tools = 0;
  const agent = new Agent({ provider: fixture.provider, tools: [{ ...tool, execute() { tools++; return "evidence"; } }], dispatch: {
    ...direct, async model(call, invoke) { const result = await invoke(); if (call.turn === 1) { arrived.release(); await settle.promise; } return result; },
  } });
  const pending = agent.prompt("research");
  await arrived.promise;
  assert.equal(tools, 0); assert.equal(fixture.pendingResponses(), 1);
  settle.release(); await pending;
  assert.equal(tools, 1); assert.equal(fixture.pendingResponses(), 0);
});

test("R7.4 failed tool settlement prevents another model request", async () => {
  const fixture = sequence(); let tools = 0;
  const agent = new Agent({ provider: fixture.provider, tools: [{ ...tool, execute() { tools++; return "evidence"; } }], dispatch: {
    ...direct, async tool(_call, invoke) { await invoke(); throw new Error("settlement unavailable"); },
  } });
  await assert.rejects(agent.prompt("research"), /settlement unavailable/);
  assert.equal(tools, 1); assert.equal(fixture.pendingResponses(), 1);
});

test("R7.4 policy wait cannot bypass upstream cancellation with its own signal", async () => {
  const fixture = sequence(); const controller = new AbortController();
  const agent = new Agent({ provider: fixture.provider, signal: controller.signal, dispatch: {
    ...direct, async model(_call, invoke) { controller.abort(); return invoke({ signal: new AbortController().signal }); },
  } });
  const result = await agent.prompt("research");
  assert.equal(result.stopReason, "aborted");
  assert.equal(fixture.pendingResponses(), 2);
});

test("R7.4 a policy cannot execute the same model callback twice", async () => {
  const fixture = sequence();
  const agent = new Agent({ provider: fixture.provider, tools: [tool], dispatch: {
    ...direct, async model(_call, invoke) { await invoke(); return invoke(); },
  } });
  const result = await agent.prompt("research");
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /already invoked/);
  assert.equal(fixture.pendingResponses(), 1);
});
