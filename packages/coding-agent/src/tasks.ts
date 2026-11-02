import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { contentTaskSchema, nextRunAt, openLocalTaskHost, type LocalTaskHost, type LocalTaskHostOptions, type MemoryState, type DeliveredContentItem } from "@simple-coding-agent/runtime";

export type TaskRuntimeOptions = Omit<LocalTaskHostOptions, "workspaceRoot" | "now"> & { allowedRoot: string; now?: Date };
export type SourceKind = "mock" | "browser" | "rss" | "url";
export type MemoryProfile = Pick<MemoryState, "interests" | "blockedTopics" | "sourceWeights">;
export type FeedbackSignal = "clicked" | "saved" | "not_interested" | "dismissed";
export type ScheduledTask = {
  id: string; title: string; mode: "live" | "demo"; everyMs?: number;
  source: { kind: SourceKind; url?: string; query?: string };
  enabled: boolean; createdAt: string; updatedAt: string; lastRunAt?: string; nextRunAt?: string;
};
export type ScoredContentItem = DeliveredContentItem & { reasons: string[] };
export type TaskRunResult = { taskId: string; runId: string; digestPath: string; itemCount: number; topItems: ScoredContentItem[] };
export type CreateTaskArgs = { id: string; title?: string; every?: string; source?: SourceKind; url?: string; query?: string };
export type RecordFeedbackArgs = { taskId: string; itemId: string; signal: FeedbackSignal; requestKey?: string };
export type FeedbackRecord = RecordFeedbackArgs & { id: string; changed: boolean };

function openHost(runtime: TaskRuntimeOptions) {
  return openLocalTaskHost({ ...runtime, workspaceRoot: runtime.allowedRoot, now: runtime.now ? () => runtime.now! : undefined });
}

async function withHost<T>(runtime: TaskRuntimeOptions, operation: (host: LocalTaskHost) => Promise<T> | T): Promise<T> {
  const host = openHost(runtime);
  try { return await operation(host); }
  catch (error) { throw new Error(host.store.redactor.text(error instanceof Error ? error.message : "Task operation failed")); }
  finally { await host.close(); }
}

export function normalizeTaskId(value: string): string {
  if (!value.trim()) throw new Error("Task id is required");
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug && slug.length <= 64 && !/[^\x00-\x7f]/.test(value)) return slug;
  return `${slug.slice(0, 47) || "task"}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function scheduleExpression(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = value.trim().match(/^(\d+)\s*(s|m|h|d|second|seconds|minute|minutes|hour|hours|day|days)$/i);
  if (!match) throw new Error(`Invalid interval: ${value}`);
  return `every ${match[1]}${match[2].toLowerCase()[0]}`;
}

function taskList(host: LocalTaskHost): ScheduledTask[] {
  const schedules = host.store.readSchedulesSync();
  return host.store.listContentTasks().map(({ definition: task, updatedAt }) => {
    const schedule = schedules.find((entry) => entry.taskId === task.id);
    const source = task.sources[0];
    return { id: task.id, title: task.title, mode: task.mode, source: { kind: source.kind, url: source.url, ...(source.kind === "mock" ? { query: source.query } : {}) }, enabled: schedule?.enabled ?? true, createdAt: updatedAt, updatedAt,
      ...(schedule ? { nextRunAt: schedule.nextRunAt, lastRunAt: schedule.lastRunAt } : {}) };
  });
}

export async function createScheduledTask(args: CreateTaskArgs, runtime: TaskRuntimeOptions): Promise<ScheduledTask> {
  return withHost(runtime, async (host) => {
    host.assertOperator();
    if (!args.source) throw new Error("An explicit --source mock|browser|rss|url is required; mock is demo-only");
    const id = normalizeTaskId(args.id);
    const definition = contentTaskSchema.parse({ id, title: args.title?.trim() || args.id.trim(), instruction: args.query?.trim() || "Select valuable content with grounded summaries and exact source quotes.",
      mode: args.source === "mock" ? "demo" : "live", model: args.source === "mock" ? "demo-faux" : host.env.DEEPSEEK_MODEL,
      sources: [args.source === "mock" ? { id: "mock", kind: "mock", url: "https://example.test/demo", ...(args.query ? { query: args.query } : {}) } : { id: args.source, kind: args.source, url: args.url }] });
    if (definition.mode === "demo" && host.env.NODE_ENV === "production") throw new Error("Demo content tasks are disabled in production");
    for (const source of definition.sources) if (source.kind !== "mock") await host.store.network.validate(source.url);
    const cron = scheduleExpression(args.every);
    const schedule = cron ? { id: `cli-${id}`, taskId: id, title: definition.title, enabled: true, cron, timezone: "UTC", overlapPolicy: "queue" as const, nextRunAt: nextRunAt({ cron, timezone: "UTC" }, runtime.now ?? new Date()) } : undefined;
    host.store.database.sqlite.transaction(() => {
      host.store.saveContentTask(definition, 0);
      if (schedule) host.store.createScheduleSync(schedule);
    }).immediate();
    return taskList(host).find((task) => task.id === id)!;
  });
}

export async function listScheduledTasks(runtime: TaskRuntimeOptions): Promise<ScheduledTask[]> {
  return withHost(runtime, taskList);
}

export async function updatePreferences(runtime: TaskRuntimeOptions, patch: Partial<MemoryProfile>): Promise<MemoryProfile> {
  return withHost(runtime, (host) => {
    if (Object.values(patch).some((value) => value !== undefined)) host.assertOperator();
    return host.store.memory.replacePreferences(patch, host.identity.id);
  });
}

export async function recordTaskFeedback(args: RecordFeedbackArgs, runtime: TaskRuntimeOptions): Promise<FeedbackRecord> {
  return withHost(runtime, (host) => {
    host.assertOperator();
    const linked = host.store.database.sqlite.prepare("select 1 from run_content_results r join run_task_snapshots t on t.run_id=r.run_id where r.content_id=? and json_extract(t.definition_json,'$.id')=? limit 1").get(args.itemId, args.taskId);
    if (!linked) throw new Error("Feedback item does not belong to this task");
    return { ...args, ...host.store.memory.recordFeedback(args.itemId, args.signal, host.identity.id, args.requestKey) };
  });
}

async function exportRun(host: LocalTaskHost, runId: string, root: string): Promise<TaskRunResult> {
  const detail = host.store.readRunDetail(runId);
  if (!detail?.task) throw new Error("Run task snapshot not found");
  if (detail.run.status !== "completed" || !detail.result) {
    const failure = [...detail.events].reverse().find((event) => event.type === "run.failed" || event.type === "run.cancelled");
    throw new Error(`Run ${runId} ${detail.run.status}: ${failure?.payload.detail ?? failure?.payload.reason ?? "no committed receipt"}`);
  }
  const task = detail.task.definition;
  const items = detail.result.items;
  const directory = join(root, "data", "exports", "digests");
  await mkdir(directory, { recursive: true });
  const digestPath = join(directory, `${runId}.md`);
  const sections = items.map((item, index) => `## ${index + 1}. ${item.title}\n\nItem: ${item.id}\nStatus: ${item.status}\nScore: ${item.score}\nReason: ${item.reason}\nLink: ${item.url ?? "none"}\n\n${item.summary}\n\n${(item.citations ?? []).map((citation) => `> ${citation.quote}\n\nSource: ${citation.readUrl}`).join("\n\n")}`).join("\n\n");
  await writeFile(digestPath, `# ${task.title}\n\nTask: ${task.id}\nRun: ${runId}\nMode: ${task.mode}\nOutcome: ${detail.result.outcome}\nItems: ${items.length}\nNew deliveries: ${detail.result.deliveries.length}\n\n${sections}\n`, { flag: "wx" });
  return { taskId: task.id, runId, digestPath, itemCount: items.length, topItems: items.map((item) => ({ ...item, reasons: [item.reason] })) };
}

export async function runScheduledTask(id: string, runtime: TaskRuntimeOptions): Promise<TaskRunResult> {
  return withHost(runtime, async (host) => {
    host.assertOperator();
    const runId = await host.scheduler.runTask(id, { actor: host.identity.id, key: randomUUID() });
    await host.scheduler.idle();
    return exportRun(host, runId, runtime.allowedRoot);
  });
}

async function tick(host: LocalTaskHost, runtime: TaskRuntimeOptions): Promise<TaskRunResult[]> {
  host.assertOperator();
  const admissions = await host.scheduler.tick(runtime.now ?? new Date());
  await host.scheduler.idle();
  const results: TaskRunResult[] = [];
  for (const admission of admissions) if (admission.status !== "skipped") results.push(await exportRun(host, admission.runId, runtime.allowedRoot));
  return results;
}

export async function runDueTasks(runtime: TaskRuntimeOptions): Promise<TaskRunResult[]> {
  return withHost(runtime, (host) => tick(host, runtime));
}

export async function runTaskDaemon(runtime: TaskRuntimeOptions, options: { intervalMs: number; once?: boolean; signal?: AbortSignal; onTick: (results: TaskRunResult[]) => void }) {
  return withHost(runtime, async (host) => {
    host.assertOperator();
    const abort = () => { void host.scheduler.stop(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!options.signal?.aborted) {
        options.onTick(await tick(host, runtime));
        if (options.once) return;
        await sleep(options.intervalMs, undefined, { signal: options.signal });
      }
    } catch (error) { if (!options.signal?.aborted) throw error; }
    finally { options.signal?.removeEventListener("abort", abort); }
  });
}

export function formatTaskList(tasks: ScheduledTask[]): string {
  return tasks.length ? tasks.map((task) => `${task.id} | ${task.mode} | ${task.source.kind} | ${task.enabled ? "enabled" : "paused"} | next ${task.nextRunAt ?? "manual"}`).join("\n") : "No scheduled tasks.";
}
