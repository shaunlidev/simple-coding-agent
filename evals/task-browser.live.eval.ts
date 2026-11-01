import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScheduledTask, runScheduledTask } from "../packages/coding-agent/src/tasks.ts";

test("live browser scenario collects local social-style page into a digest", { skip: process.env.RUN_BROWSER_LIVE !== "1" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-browser-live-"));
  const server = createServer((_request: unknown, response: ServerResponse) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <title>Local Social Feed</title>
      <main>
        <article>
          <a href="/agent-runtime">AI agent runtime events for scheduled social collection</a>
          <p>Scheduler, memory, browser collection, ranking, summary, delivery, and feedback loop acceptance criteria.</p>
        </article>
      </main>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.equal(address !== null, true);
  if (!address || typeof address !== "object") throw new Error("Server did not expose a TCP address");
  const url = `http://127.0.0.1:${address.port}/feed`;

  try {
    await createScheduledTask({ id: "browser-social-brief", source: "browser", url }, { allowedRoot: root });
    const result = await runScheduledTask("browser-social-brief", { allowedRoot: root });
    const digest = new TextDecoder().decode(await readFile(result.digestPath));

    assert.equal(result.itemCount > 0, true);
    assert.equal(digest.includes("AI agent runtime events"), true);
    assert.equal(digest.includes("feedback loop"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
