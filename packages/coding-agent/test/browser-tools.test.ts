import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "../../ai/src/index.ts";
import { createBrowserTools, createPlaywrightBrowserAdapter, type BrowserAdapter } from "../src/browser-tools.ts";

function findTool(name: string, adapter: BrowserAdapter): ToolDefinition {
  const tool = createBrowserTools({ adapter }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

test("browser tools call the adapter in order", async () => {
  const calls: string[] = [];
  const adapter: BrowserAdapter = {
    async navigate(args) {
      calls.push(`navigate:${args.url}:${args.headless}`);
      return "navigated";
    },
    async snapshot(args) {
      calls.push(`snapshot:${args?.maxTextLength}`);
      return { url: "https://example.com", title: "Example", text: "Hello", elements: [] };
    },
    async click(args) {
      calls.push(`click:${args.selector}`);
      return "clicked";
    },
    async type(args) {
      calls.push(`type:${args.selector}:${args.text}:${args.submit}`);
      return "typed";
    },
    async close() {
      calls.push("close");
      return "closed";
    },
  };

  assert.equal(await findTool("browser_navigate", adapter).execute?.({ url: "https://example.com" }), "navigated");
  assert.deepEqual(await findTool("browser_snapshot", adapter).execute?.({ maxTextLength: 100 }), {
    url: "https://example.com",
    title: "Example",
    text: "Hello",
    elements: [],
  });
  assert.equal(await findTool("browser_click", adapter).execute?.({ selector: "#go" }), "clicked");
  assert.equal(await findTool("browser_type", adapter).execute?.({ selector: "input", text: "hello", submit: true }), "typed");
  assert.equal(await findTool("browser_close", adapter).execute?.({}), "closed");

  assert.deepEqual(calls, [
    "navigate:https://example.com:undefined",
    "snapshot:100",
    "click:#go",
    "type:input:hello:true",
    "close",
  ]);
});

test("browser tools propagate clear adapter errors", async () => {
  const adapter: BrowserAdapter = {
    async navigate() {
      throw new Error("Playwright is required for browser tools");
    },
    async snapshot() {
      throw new Error("unused");
    },
    async click() {
      throw new Error("unused");
    },
    async type() {
      throw new Error("unused");
    },
    async close() {
      throw new Error("unused");
    },
  };

  await assert.rejects(
    findTool("browser_navigate", adapter).execute?.({ url: "https://example.com" }) as Promise<unknown>,
    /Playwright is required/,
  );
});

test("default Playwright adapter fails clearly when Playwright cannot load", async () => {
  const adapter = createPlaywrightBrowserAdapter({
    async loadPlaywright() {
      throw new Error("Cannot find package 'playwright'");
    },
  });

  await assert.rejects(
    adapter.navigate({ url: "https://example.com" }),
    /Install it with "npm install -D playwright"/,
  );
});
