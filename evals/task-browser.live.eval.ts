import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SafeNetwork } from "@simple-coding-agent/security";
import { createScheduledTask, runScheduledTask } from "../packages/coding-agent/src/tasks.ts";
import { createDemoContentProvider } from "../packages/runtime/src/demo-content.ts";
import { localEnv } from "../packages/coding-agent/test/task-fixture.ts";

test("actual Chromium task collection through shared guards, with controlled source/model", { skip: process.env.RUN_BROWSER_LIVE !== "1" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-browser-live-"));
  let requests = 0;
  const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => {
    requests++;
    return { url: url.href, status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: new TextEncoder().encode('<!doctype html><title>Social Feed</title><main><article><h1>AI agent runtime events</h1><p>Scheduler, memory, browser collection, ranking, summary, delivery, and feedback loop acceptance criteria.</p></article></main>') };
  } });
  const runtime = { allowedRoot: root, env: localEnv, network, providerFactory: createDemoContentProvider };
  try {
    await createScheduledTask({ id: "browser-social-brief", source: "browser", url: "https://source.test/feed" }, runtime);
    const result = await runScheduledTask("browser-social-brief", runtime);
    const digest = await readFile(result.digestPath, "utf8");
    assert.equal(result.itemCount, 1);
    assert.ok(requests > 0);
    assert.match(digest, /AI agent runtime events/);
    assert.match(digest, /feedback loop/);
    assert.match(digest, /Source: https:\/\/source.test\/feed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
