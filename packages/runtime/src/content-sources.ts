import { createHash, randomUUID } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import Parser from "rss-parser";
import type { SafeNetwork } from "@simple-coding-agent/security";
import { readBrowserSource } from "./browser-source.js";
import { sourceUrlSchema, type ContentTask, type ObservedDocument, type RemoteSource, type SourceRead } from "./content-contract.js";

class SourceError extends Error {
  constructor(readonly code: "http" | "parse", message: string, readonly retryable: boolean) { super(message); }
}

function plainText(html: string, url: string, article: boolean): { title: string; text: string } {
  // Never enable jsdom runScripts/resources. Only extracted plain text leaves this function.
  const dom = new JSDOM(html, { url });
  try {
    const title = dom.window.document.title;
    for (const node of dom.window.document.querySelectorAll("script,style,noscript,nav,footer")) node.remove();
    const fallback = dom.window.document.body.textContent || "";
    const parsed = article ? new Readability(dom.window.document).parse() : null;
    return { title: parsed?.title || title, text: (parsed?.textContent || fallback).replace(/\s+/g, " ").trim() };
  } finally { dom.window.close(); }
}

export async function collectContentSource(options: {
  runId: string; source: RemoteSource; limits: ContentTask["limits"]; network: SafeNetwork;
  redact: (value: string) => string; signal?: AbortSignal;
  browser?: typeof readBrowserSource;
}): Promise<SourceRead> {
  const { source, limits, network, redact } = options;
  const start = performance.now();
  const deadline = AbortSignal.timeout(limits.sourceTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const durationMs = () => performance.now() - start;
  const documents: ObservedDocument[] = [];
  function add(input: { title: string; text: string; url: string; readUrl: string; representation: ObservedDocument["representation"] }) {
    const normalized = redact(input.text).replace(/\s+/g, " ").trim();
    if (!normalized || documents.length >= limits.maxDocumentsPerSource) return;
    const text = normalized.slice(0, limits.maxTextChars);
    documents.push({ id: randomUUID(), runId: options.runId, sourceId: source.id, representation: input.representation,
      title: redact(input.title || source.id).slice(0, 500), url: sourceUrlSchema.parse(redact(input.url)), readUrl: sourceUrlSchema.parse(redact(input.readUrl)),
      text, hash: createHash("sha256").update(text).digest("hex"), collectedAt: new Date().toISOString(), truncated: normalized.length > text.length,
    });
  }
  try {
    signal.throwIfAborted();
    if (source.kind === "browser") {
      const page = await (options.browser ?? readBrowserSource)(network, source.url, { signal, timeoutMs: limits.sourceTimeoutMs });
      add({ ...page, readUrl: page.url, representation: "page_text" });
    } else {
      const response = await network.read(source.url, { signal });
      if (response.status < 200 || response.status >= 300) throw new SourceError("http", `Source returned HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
      const body = new TextDecoder().decode(response.body);
      if (source.kind === "rss") {
        let feed;
        try { feed = await new Parser().parseString(body); }
        catch { throw new SourceError("parse", "Source is not a supported RSS/Atom feed", false); }
        for (const item of feed.items.slice(0, limits.maxDocumentsPerSource)) {
          let url: string;
          try { url = sourceUrlSchema.parse(new URL(item.link || response.url, response.url).href); }
          catch { throw new SourceError("parse", "Feed item has an invalid link", false); }
          const text = item.contentSnippet || plainText(item.content || item.summary || "", response.url, false).text;
          add({ title: item.title || source.id, text, url, readUrl: response.url, representation: "feed_entry" });
        }
      } else {
        const type = response.headers["content-type"] ?? "";
        if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(type)) throw new SourceError("parse", "URL source must return HTML or plain text", false);
        const extracted = /text\/plain/i.test(type) ? { title: source.id, text: body } : plainText(body, response.url, true);
        add({ ...extracted, url: response.url, readUrl: response.url, representation: "page_text" });
      }
    }
    signal.throwIfAborted();
    return { status: "ok", sourceId: source.id, documents, durationMs: durationMs() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source collection failed";
    const code = options.signal?.aborted ? "cancelled" : deadline.aborted ? "timeout" : error instanceof SourceError ? error.code : message.startsWith("Network policy:") ? "policy" : "network";
    return { status: "failed", sourceId: source.id, code, message: redact(message).slice(0, 1000), retryable: error instanceof SourceError ? error.retryable : code === "network" || code === "timeout", durationMs: durationMs() };
  }
}
