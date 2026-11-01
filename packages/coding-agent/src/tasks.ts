import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPlaywrightBrowserAdapter, type BrowserAdapter } from "./browser-tools.js";

export type TaskRuntimeOptions = {
  allowedRoot: string;
  now?: Date;
  browserAdapter?: BrowserAdapter;
  fetch?: typeof fetch;
};

export type SourceKind = "mock" | "browser" | "rss";

export type ScheduledTask = {
  id: string;
  title: string;
  everyMs?: number;
  source: {
    kind: SourceKind;
    url?: string;
    query?: string;
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
};

export type TaskStore = {
  version: 1;
  tasks: ScheduledTask[];
};

export type AgentTaskEventType =
  | "task_due"
  | "fetch_started"
  | "fetch_completed"
  | "content_cleaned"
  | "content_scored"
  | "summary_created"
  | "delivery_created"
  | "feedback_recorded"
  | "run_failed";

export type AgentTaskEvent = {
  id: string;
  taskId: string;
  runId: string;
  type: AgentTaskEventType;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type MemoryProfile = {
  interests: string[];
  blockedTopics: string[];
  sourceWeights: Record<string, number>;
};

export type FeedbackSignal = "clicked" | "saved" | "not_interested" | "dismissed";

export type FeedbackRecord = {
  taskId: string;
  itemId: string;
  signal: FeedbackSignal;
  createdAt: string;
};

export type RawContentItem = {
  id?: string;
  source: string;
  title: string;
  url?: string;
  text: string;
  publishedAt?: string;
};

export type ScoredContentItem = RawContentItem & {
  id: string;
  score: number;
  reasons: string[];
  summary: string;
};

export type TaskRunResult = {
  taskId: string;
  runId: string;
  digestPath: string;
  itemCount: number;
  topItems: ScoredContentItem[];
};

export type CreateTaskArgs = {
  id: string;
  title?: string;
  every?: string;
  source?: SourceKind;
  url?: string;
  query?: string;
};

export type RecordFeedbackArgs = {
  taskId: string;
  itemId: string;
  signal: FeedbackSignal;
};

const AGENT_ROOT = "docs/agent";
const DEFAULT_STORE: TaskStore = { version: 1, tasks: [] };
const DEFAULT_MEMORY: MemoryProfile = {
  interests: ["AI agent", "coding agent", "automation", "developer tools"],
  blockedTopics: [],
  sourceWeights: {},
};

function nowIso(runtime: TaskRuntimeOptions): string {
  return (runtime.now ?? new Date()).toISOString();
}

function taskPath(runtime: TaskRuntimeOptions, ...parts: string[]): string {
  return join(runtime.allowedRoot, AGENT_ROOT, ...parts);
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(new TextDecoder().decode(await readFile(path))) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureParent(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await ensureParent(path);
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseEvery(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+)\s*(m|h|d|minute|minutes|hour|hours|day|days)$/i);
  if (!match) throw new Error(`Invalid interval: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m" || unit.startsWith("minute")) return amount * 60_000;
  if (unit === "h" || unit.startsWith("hour")) return amount * 60 * 60_000;
  return amount * 24 * 60 * 60_000;
}

function addMs(iso: string, ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function createEvent(runtime: TaskRuntimeOptions, taskId: string, runId: string, type: AgentTaskEventType, payload: Record<string, unknown>): AgentTaskEvent {
  return {
    id: `${runId}-${type}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    taskId,
    runId,
    type,
    createdAt: nowIso(runtime),
    payload,
  };
}

async function appendEvent(runtime: TaskRuntimeOptions, event: AgentTaskEvent): Promise<void> {
  await appendJsonl(taskPath(runtime, "events", "queue.jsonl"), event);
}

async function appendRun(runtime: TaskRuntimeOptions, value: unknown): Promise<void> {
  await appendJsonl(taskPath(runtime, "events", "runs.jsonl"), value);
}

export async function readTaskStore(runtime: TaskRuntimeOptions): Promise<TaskStore> {
  return readJson(taskPath(runtime, "schedules", "tasks.json"), DEFAULT_STORE);
}

export async function writeTaskStore(runtime: TaskRuntimeOptions, store: TaskStore): Promise<void> {
  await writeJson(taskPath(runtime, "schedules", "tasks.json"), store);
}

export async function createScheduledTask(args: CreateTaskArgs, runtime: TaskRuntimeOptions): Promise<ScheduledTask> {
  if (!args.id.trim()) throw new Error("Task id is required");
  const id = slugify(args.id);
  const store = await readTaskStore(runtime);
  if (store.tasks.some((task) => task.id === id)) throw new Error(`Task already exists: ${id}`);
  const createdAt = nowIso(runtime);
  const everyMs = parseEvery(args.every);
  const task: ScheduledTask = {
    id,
    title: args.title?.trim() || id,
    everyMs,
    source: { kind: args.source ?? "mock", ...(args.url ? { url: args.url } : {}), ...(args.query ? { query: args.query } : {}) },
    enabled: true,
    createdAt,
    updatedAt: createdAt,
    nextRunAt: addMs(createdAt, everyMs),
  };
  await writeTaskStore(runtime, { version: 1, tasks: [...store.tasks, task] });
  return task;
}

export async function listScheduledTasks(runtime: TaskRuntimeOptions): Promise<ScheduledTask[]> {
  return (await readTaskStore(runtime)).tasks;
}

async function readMemory(runtime: TaskRuntimeOptions): Promise<MemoryProfile> {
  return readJson(taskPath(runtime, "memory", "preferences.json"), DEFAULT_MEMORY);
}

async function readFeedback(runtime: TaskRuntimeOptions): Promise<FeedbackRecord[]> {
  const path = taskPath(runtime, "memory", "feedback.jsonl");
  const content = await readFile(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FeedbackRecord);
}

export async function updatePreferences(runtime: TaskRuntimeOptions, patch: Partial<MemoryProfile>): Promise<MemoryProfile> {
  const current = await readMemory(runtime);
  const next: MemoryProfile = {
    interests: patch.interests ?? current.interests,
    blockedTopics: patch.blockedTopics ?? current.blockedTopics,
    sourceWeights: { ...current.sourceWeights, ...(patch.sourceWeights ?? {}) },
  };
  await writeJson(taskPath(runtime, "memory", "preferences.json"), next);
  return next;
}

export async function recordTaskFeedback(args: RecordFeedbackArgs, runtime: TaskRuntimeOptions): Promise<FeedbackRecord> {
  const record: FeedbackRecord = { ...args, createdAt: nowIso(runtime) };
  const runId = `feedback-${new Date(record.createdAt).getTime()}`;
  await appendJsonl(taskPath(runtime, "memory", "feedback.jsonl"), record);
  await appendEvent(runtime, createEvent(runtime, args.taskId, runId, "feedback_recorded", { itemId: args.itemId, signal: args.signal }));
  return record;
}

function stableId(item: RawContentItem): string {
  return slugify(item.url ?? `${item.source}-${item.title}`) || `item-${Math.abs(hash(`${item.source}:${item.title}:${item.text}`))}`;
}

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
  return result;
}

function dedupe(items: RawContentItem[]): RawContentItem[] {
  const seen = new Set<string>();
  const unique: RawContentItem[] = [];
  for (const item of items) {
    const key = stableId(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function summarize(item: RawContentItem): string {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text.length <= 220) return text || item.title;
  return `${text.slice(0, 217).trim()}...`;
}

function scoreItem(item: RawContentItem, memory: MemoryProfile, feedback: FeedbackRecord[]): ScoredContentItem {
  const text = `${item.title} ${item.text}`.toLowerCase();
  const reasons: string[] = [];
  let score = 50;
  for (const interest of memory.interests) {
    if (text.includes(interest.toLowerCase())) {
      score += 15;
      reasons.push(`matches interest: ${interest}`);
    }
  }
  for (const topic of memory.blockedTopics) {
    if (text.includes(topic.toLowerCase())) {
      score -= 40;
      reasons.push(`blocked topic: ${topic}`);
    }
  }
  const sourceWeight = memory.sourceWeights[item.source] ?? 1;
  score += Math.round(sourceWeight * 10);
  reasons.push(`source weight: ${sourceWeight}`);
  const id = item.id ?? stableId(item);
  for (const signal of feedback.filter((entry) => entry.itemId === id)) {
    if (signal.signal === "clicked") score += 5;
    if (signal.signal === "saved") score += 10;
    if (signal.signal === "dismissed") score -= 10;
    if (signal.signal === "not_interested") score -= 25;
  }
  return { ...item, id, score, reasons, summary: summarize(item) };
}

async function fetchMock(task: ScheduledTask): Promise<RawContentItem[]> {
  const query = task.source.query ?? "AI agent";
  return [
    {
      source: "mock",
      title: `${query} runtime event queues for coding agents`,
      url: "https://example.test/agent-runtime-events",
      text: "A practical note about coding agent runtime event queues, durable runs, and acceptance harnesses.",
    },
    {
      source: "mock",
      title: "Generic productivity thread",
      url: "https://example.test/generic-productivity",
      text: "A lightweight productivity update with shallow advice and little implementation detail.",
    },
    {
      source: "mock",
      title: "Browser automation and social signal collection",
      url: "https://example.test/browser-social-signals",
      text: "Browser automation can collect page titles, links, text snapshots, and user feedback for personalized digests.",
    },
  ];
}

async function fetchBrowser(task: ScheduledTask, runtime: TaskRuntimeOptions): Promise<RawContentItem[]> {
  if (!task.source.url) throw new Error("Browser source requires --url");
  const adapter = runtime.browserAdapter ?? createPlaywrightBrowserAdapter();
  await adapter.navigate({ url: task.source.url, headless: true });
  const snapshot = await adapter.snapshot({ maxTextLength: 8_000 });
  await adapter.close();
  const linkItems = snapshot.elements
    .filter((element) => element.tag === "a" && element.text && element.text.length > 8)
    .slice(0, 8)
    .map((element, index) => ({
      source: "browser",
      title: element.text ?? `Browser link ${index + 1}`,
      url: snapshot.url,
      text: `${element.text ?? ""}\n${snapshot.text}`.trim(),
    }));
  return linkItems.length > 0
    ? linkItems
    : [{ source: "browser", title: snapshot.title || task.title, url: snapshot.url, text: snapshot.text }];
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tag(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) : undefined;
}

async function fetchRss(task: ScheduledTask, runtime: TaskRuntimeOptions): Promise<RawContentItem[]> {
  if (!task.source.url) throw new Error("RSS source requires --url");
  const response = await (runtime.fetch ?? fetch)(task.source.url);
  if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);
  const xml = await response.text();
  const blocks = [...xml.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  return blocks.slice(0, 20).map((block) => ({
    source: "rss",
    title: tag(block, "title") ?? "Untitled",
    url: tag(block, "link") ?? undefined,
    text: tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? "",
    publishedAt: tag(block, "pubDate") ?? tag(block, "updated"),
  }));
}

async function fetchSource(task: ScheduledTask, runtime: TaskRuntimeOptions): Promise<RawContentItem[]> {
  if (task.source.kind === "browser") return fetchBrowser(task, runtime);
  if (task.source.kind === "rss") return fetchRss(task, runtime);
  return fetchMock(task);
}

function renderDigest(task: ScheduledTask, runId: string, items: ScoredContentItem[], createdAt: string): string {
  const body = items
    .map((item, index) => {
      const link = item.url ? `\nLink: ${item.url}` : "";
      return `## ${index + 1}. ${item.title}\n\nScore: ${item.score}\nReasons: ${item.reasons.join("; ")}${link}\n\n${item.summary}`;
    })
    .join("\n\n");
  return `# ${task.title}\n\nTask: ${task.id}\nRun: ${runId}\nCreated: ${createdAt}\nItems: ${items.length}\n\n${body}\n`;
}

export async function runScheduledTask(id: string, runtime: TaskRuntimeOptions): Promise<TaskRunResult> {
  const store = await readTaskStore(runtime);
  const task = store.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  const runId = `${id}-${new Date(nowIso(runtime)).getTime()}`;
  try {
    await appendEvent(runtime, createEvent(runtime, id, runId, "task_due", { trigger: "manual" }));
    await appendEvent(runtime, createEvent(runtime, id, runId, "fetch_started", { source: task.source }));
    const rawItems = await fetchSource(task, runtime);
    await appendEvent(runtime, createEvent(runtime, id, runId, "fetch_completed", { count: rawItems.length }));
    const cleaned = dedupe(rawItems).filter((item) => item.title.trim() && item.text.trim());
    await appendEvent(runtime, createEvent(runtime, id, runId, "content_cleaned", { count: cleaned.length }));
    const memory = await readMemory(runtime);
    const feedback = await readFeedback(runtime);
    const scored = cleaned.map((item) => scoreItem(item, memory, feedback)).sort((left, right) => right.score - left.score);
    await appendEvent(runtime, createEvent(runtime, id, runId, "content_scored", { count: scored.length }));
    await appendEvent(runtime, createEvent(runtime, id, runId, "summary_created", { count: scored.length, mode: "extractive" }));
    const createdAt = nowIso(runtime);
    const digestPath = taskPath(runtime, "digests", `${createdAt.slice(0, 10)}-${id}.md`);
    await ensureParent(digestPath);
    await writeFile(digestPath, renderDigest(task, runId, scored, createdAt));
    await appendEvent(runtime, createEvent(runtime, id, runId, "delivery_created", { digestPath, count: scored.length }));
    await appendRun(runtime, { taskId: id, runId, status: "passed", createdAt, digestPath, itemCount: scored.length });
    const nextTasks = store.tasks.map((candidate) =>
      candidate.id === id
        ? { ...candidate, lastRunAt: createdAt, nextRunAt: addMs(createdAt, candidate.everyMs), updatedAt: createdAt }
        : candidate,
    );
    await writeTaskStore(runtime, { version: 1, tasks: nextTasks });
    return { taskId: id, runId, digestPath, itemCount: scored.length, topItems: scored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEvent(runtime, createEvent(runtime, id, runId, "run_failed", { error: message }));
    await appendRun(runtime, { taskId: id, runId, status: "failed", createdAt: nowIso(runtime), error: message });
    throw error;
  }
}

export async function runDueTasks(runtime: TaskRuntimeOptions): Promise<TaskRunResult[]> {
  const now = new Date(nowIso(runtime)).getTime();
  const due = (await readTaskStore(runtime)).tasks.filter((task) => task.enabled && (!task.nextRunAt || new Date(task.nextRunAt).getTime() <= now));
  const results: TaskRunResult[] = [];
  for (const task of due) {
    results.push(await runScheduledTask(task.id, runtime));
  }
  return results;
}

export function formatTaskList(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return "No scheduled tasks.";
  return tasks
    .map((task) => `${task.id} | ${task.source.kind}${task.source.url ? ` | ${task.source.url}` : ""} | next ${task.nextRunAt ?? "manual"}`)
    .join("\n");
}
