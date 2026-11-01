import assert from "node:assert/strict";
import test from "node:test";
import { SafeNetwork, type NetworkDocument } from "@simple-coding-agent/security";
import { SQLiteRuntimeStore, runContentPipeline } from "../src/index.ts";

test("R2.4 real pipeline refuses off-list URL, RSS and browser before invoking transport", async () => {
  const store = new SQLiteRuntimeStore();
  let calls = 0;
  const network = new SafeNetwork({ allowlist: ["https://allowed.test"], transport: async () => { calls++; throw new Error("must not reach transport"); } });
  try {
    for (const kind of ["url", "rss", "browser"] as const) {
      await assert.rejects(runContentPipeline(store, `denied-${kind}`, { network, sources: [{ id: kind, kind, url: "https://off-list.test" }] }), /All content sources failed/);
      const events = await store.listEvents(`denied-${kind}`);
      assert.equal(events.some((event) => String(event.payload.detail).includes("outside allowlist")), true);
    }
    assert.equal(calls, 0);
  } finally { store.database.sqlite.close(); }
});

test("R2.4 allowed pipeline uses validated content and blocks a private redirect without a second request", async () => {
  const store = new SQLiteRuntimeStore();
  const visited: string[] = [];
  const network = new SafeNetwork({ allowlist: ["https://allowed.test", "http://127.0.0.1"], resolve: async () => [{ address: "93.184.216.34", family: 4 }], transport: async ({ url }): Promise<NetworkDocument> => {
    visited.push(url.href);
    return url.pathname === "/redirect"
      ? { url: url.href, status: 302, headers: { location: "http://127.0.0.1/secret" }, body: new Uint8Array() }
      : { url: url.href, status: 200, headers: {}, body: new TextEncoder().encode("Agent runtime test content from the validated source") };
  } });
  try {
    await assert.rejects(runContentPipeline(store, "redirect", { network, sources: [{ id: "redirect", kind: "url", url: "https://allowed.test/redirect" }] }), /All content sources failed/);
    assert.deepEqual(visited, ["https://allowed.test/redirect"]);
    const items = await runContentPipeline(store, "allowed", { network, sources: [{ id: "allowed", kind: "url", url: "https://allowed.test/content" }] });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.summary.includes("validated source"), true);
  } finally { store.database.sqlite.close(); }
});
