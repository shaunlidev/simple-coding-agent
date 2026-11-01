import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { SafeNetwork } from "@simple-coding-agent/security";
import { contentTaskSchema, sourceReadSchema, validateSummary, mergeSimilarSummaries } from "../src/content-contract.ts";
import { collectContentSource } from "../src/content-sources.ts";

const limits = contentTaskSchema.parse({ id: "test", title: "Test", instruction: "Collect news", sources: [{ id: "source", kind: "url", url: "https://source.test" }] }).limits;
function network(body: string, type = "text/html", status = 200) {
  return new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => ({ url: url.href, status, headers: { "content-type": type }, body: new TextEncoder().encode(body) }) });
}
const base = { runId: "fixture-run", limits, redact: (value: string) => value.replaceAll("synthetic-secret", "[REDACTED]") };

test("HTML collection returns hashed bounded plain text without executing script or fetching anchors", async () => {
  const result = await collectContentSource({ ...base, source: { id: "source", kind: "url", url: "https://source.test/page" }, network: network("<html><title>Read page</title><body><article>Fresh project update with synthetic-secret and verifiable evidence.</article><script>throw Error('must not execute')</script><a href='http://127.0.0.1/private'>Not visited</a></body></html>") });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("collection failed");
  assert.equal(result.documents.length, 1);
  const document = result.documents[0];
  assert.match(document.text, /Fresh project update/);
  assert.equal(document.text.includes("synthetic-secret"), false);
  assert.equal(document.text.includes("must not execute"), false);
  assert.equal(document.url, "https://source.test/page");
  assert.equal(document.hash, createHash("sha256").update(document.text).digest("hex"));
});

test("RSS and Atom preserve feed-read provenance separately from unvisited article URLs", async () => {
  const feeds = [
    '<rss version="2.0"><channel><title>Feed</title><link>https://source.test</link><description>News</description><item><title>New release</title><link>https://article.test/story</link><description><![CDATA[<p>Actual release notes from the feed.</p>]]></description></item></channel></rss>',
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><id>feed</id><updated>2026-11-01T00:00:00Z</updated><entry><title>New release</title><id>story</id><link href="https://article.test/story"/><summary>Actual release notes from the feed.</summary></entry></feed>',
  ];
  for (const feed of feeds) {
    const result = await collectContentSource({ ...base, source: { id: "feed", kind: "rss", url: "https://source.test/rss" }, network: network(feed, "application/xml") });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") throw new Error("collection failed");
    assert.equal(result.documents[0].readUrl, "https://source.test/rss");
    assert.equal(result.documents[0].url, "https://article.test/story");
    assert.equal(result.documents[0].representation, "feed_entry");
    assert.match(result.documents[0].text, /Actual release notes/);
  }
});

test("empty valid feeds differ from malformed feeds, HTTP errors and denied destinations", async () => {
  const source = { id: "feed", kind: "rss", url: "https://source.test/rss" } as const;
  const empty = await collectContentSource({ ...base, source, network: network('<rss version="2.0"><channel><title>Feed</title></channel></rss>', "application/xml") });
  assert.equal(empty.status, "ok");
  if (empty.status === "ok") assert.deepEqual(empty.documents, []);
  for (const [transport, code, retryable] of [[network("not xml"), "parse", false], [network("unavailable", "text/plain", 503), "http", true], [new SafeNetwork({ allowlist: [] }), "policy", false]] as const) {
    const result = await collectContentSource({ ...base, source, network: transport });
    assert.equal(result.status, "failed");
    if (result.status === "failed") { assert.equal(result.code, code); assert.equal(result.retryable, retryable); }
  }
});

for (const kind of ["rss", "url", "browser"] as const) {
  test(`${kind} deadline aborts actual adapter operation`, async () => {
    let aborted = false;
    const stall = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      const onAbort = () => { aborted = true; reject(signal.reason); };
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    });
    const transport = new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ signal }) => stall(signal) });
    // Keep the test alive: AbortSignal.timeout intentionally does not hold Node's event loop open.
    const timer = setTimeout(() => {}, 1000);
    try {
      const result = await collectContentSource({ ...base, limits: { ...limits, sourceTimeoutMs: 50 }, source: { id: "source", kind, url: "https://source.test" }, network: transport, browser: async (_network, _url, options) => stall(options?.signal ?? new AbortController().signal) });
      assert.equal(result.status, "failed");
      if (result.status === "failed") assert.equal(result.code, "timeout");
      assert.equal(aborted, true);
    } finally { clearTimeout(timer); }
  });
}

test("citations require exact text and current-run document membership", async () => {
  const result = await collectContentSource({ ...base, source: { id: "source", kind: "url", url: "https://source.test/page" }, network: network("Real release evidence for this run only.", "text/plain") });
  if (result.status !== "ok") throw new Error("collection failed");
  const item = { documentId: result.documents[0].id, summary: "Release evidence is available.", reason: "Matches release interests.", score: 80, quotes: ["Real release evidence"] };
  assert.equal(validateSummary({ items: [item] }, result.documents).length, 1);
  assert.throws(() => validateSummary({ items: [{ ...item, documentId: randomUUID() }] }, result.documents), /unknown/);
  assert.throws(() => validateSummary({ items: [{ ...item, quotes: ["Invented quote text"] }] }, result.documents), /does not match/);
  assert.throws(() => validateSummary({ items: [item, item] }, result.documents), /duplicate/);
});

test("browser metadata cannot leak into the strict persisted evidence contract", async () => {
  const result = await collectContentSource({ ...base, source: { id: "source", kind: "browser", url: "https://source.test/page" }, network: network(""), browser: async () => ({ title: "Browser", text: "Fresh browser evidence from the current page.", url: "https://source.test/page", links: [{ text: "Unvisited", url: "https://other.test" }], blockedRequests: ["http://127.0.0.1"] }) });
  assert.equal(sourceReadSchema.parse(result).status, "ok");
  if (result.status === "ok") {
    assert.equal(result.documents.length, 1);
    assert.equal("links" in result.documents[0], false);
    assert.equal("blockedRequests" in result.documents[0], false);
  }
});

test("similarity merging retains distinct immutable citations while duplicate URLs appear once", async () => {
  const text = "Rust release adds compiler improvements faster builds stable APIs diagnostics documentation testing and reliability.";
  const outcomes = [];
  for (const [id, url, body] of [["a", "https://source.test/a", text], ["b", "https://source.test/b", `${text} today`], ["c", "https://source.test/a#section", text]]) {
    const outcome = await collectContentSource({ ...base, source: { id, kind: "url", url }, network: network(body, "text/plain") });
    if (outcome.status === "ok") outcomes.push(...outcome.documents);
  }
  const before = structuredClone(outcomes);
  const validated = validateSummary({ items: outcomes.map((document) => ({ documentId: document.id, summary: "Rust release improves compiler and build reliability.", reason: "Relevant release news.", score: 80, quotes: [text] })) }, outcomes);
  const merged = mergeSimilarSummaries(validated);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].citations.length, 3);
  assert.deepEqual(outcomes, before);
});
