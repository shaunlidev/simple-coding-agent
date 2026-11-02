import { createHash, randomUUID } from "node:crypto";
import { createFauxProvider, type Provider } from "@simple-coding-agent/ai";
import { z } from "zod";
import { demoSourceSchema, sourceReadSchema, type ContentTask, type SourceRead } from "./content-contract.js";

export function collectDemoSource(runId: string, source: z.infer<typeof demoSourceSchema>, limits: ContentTask["limits"], redact: (text: string) => string): SourceRead {
  const items = [
    { title: `${source.query} runtime event queues for coding agents`, url: "https://example.test/agent-runtime-events", text: "A practical note about coding agent runtime event queues, durable runs, and acceptance harnesses." },
    { title: "Generic productivity thread", url: "https://example.test/generic-productivity", text: "A lightweight productivity update with shallow advice and little implementation detail." },
    { title: "Browser automation and social signal collection", url: "https://example.test/browser-social-signals", text: "Browser automation can collect page titles, links, text snapshots, and user feedback for personalized digests." },
  ];
  return { status: "ok", sourceId: source.id, durationMs: 0, documents: items.slice(0, limits.maxDocumentsPerSource).map((item) => {
    const text = redact(item.text).slice(0, limits.maxTextChars);
    return { id: randomUUID(), runId, sourceId: source.id, title: redact(item.title), text, url: item.url, readUrl: source.url, representation: "demo_fixture", hash: createHash("sha256").update(text).digest("hex"), collectedAt: new Date().toISOString(), truncated: text.length < item.text.length };
  }) };
}

export function createDemoContentProvider(task: ContentTask): Provider {
  const base = createFauxProvider({ responses: [] }).provider;
  return { ...base, stream(model, context, options) {
    const messages = context.messages.filter((message) => message.role === "tool");
    if (!messages.length) return createFauxProvider({ responses: [{ type: "success", content: task.sources.map((source) => ({ type: "tool_call", id: randomUUID(), name: "collect_source", arguments: { sourceId: source.id } })) }] }).provider.stream(model, context, options);
    const documents = messages.flatMap((message) => {
      if (message.isError) return [];
      const result = sourceReadSchema.parse(JSON.parse(message.content));
      return result.status === "ok" ? result.documents : [];
    });
    const output = { items: documents.map((document) => ({ documentId: document.id, summary: document.text, reason: "Explicit demo fixture, not live research", score: 50, quotes: [document.text.slice(0, 30), document.text.slice(8, 38), document.text.slice(16, 46)] })) };
    return createFauxProvider({ responses: [JSON.stringify(output)] }).provider.stream(model, context, options);
  } };
}
