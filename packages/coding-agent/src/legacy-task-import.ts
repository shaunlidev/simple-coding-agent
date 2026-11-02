import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import { contentTaskSchema, nextRunAt, openLocalTaskHost } from "@simple-coding-agent/runtime";
import { normalizeTaskId, type TaskRuntimeOptions } from "./tasks.js";

const legacySchema = z.object({ version: z.literal(1), tasks: z.array(z.object({
  id: z.string().min(1).max(500), title: z.string().min(1).max(160), everyMs: z.number().int().min(1000).max(366 * 86400000).optional(),
  source: z.object({ kind: z.enum(["mock", "rss", "browser"]), url: z.string().optional(), query: z.string().optional() }).strict(),
  enabled: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), lastRunAt: z.iso.datetime().optional(), nextRunAt: z.iso.datetime().optional(),
}).strict()).max(100) }).strict();
const profileSchema = z.object({ interests: z.array(z.string()).max(100), blockedTopics: z.array(z.string()).max(100), sourceWeights: z.record(z.string(), z.number()) }).strict();
const receiptSchema = z.object({ manifestHash: z.string(), mapping: z.array(z.object({ legacyId: z.string(), taskId: z.string() })), files: z.array(z.object({ path: z.string(), hash: z.string(), bytes: z.number() })), quarantinedFeedback: z.number(), historicalFiles: z.array(z.string()), policy: z.string() });
export type LegacyImportReceipt = z.infer<typeof receiptSchema>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function importLegacyTasks(runtime: TaskRuntimeOptions): Promise<LegacyImportReceipt> {
  const host = openLocalTaskHost({ ...runtime, workspaceRoot: runtime.allowedRoot, now: runtime.now ? () => runtime.now! : undefined });
  try {
    host.assertOperator();
    const root = await realpath(runtime.allowedRoot);
    const files = new Map<string, Buffer>();
    const directories = new Set<string>();
    let bytes = 0;
    async function inspect(relative: string, recurse = false): Promise<void> {
      const path = join(root, "docs/agent", relative);
      let resolved: string;
      try { resolved = await realpath(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!resolved.startsWith(`${root}${sep}`)) throw new Error("Legacy source escapes workspace");
      const info = await stat(resolved);
      if (info.isDirectory() && recurse) {
        if (directories.has(resolved) || directories.size >= 100) throw new Error("Legacy directory cycle or directory budget exceeded");
        directories.add(resolved);
        for (const name of (await readdir(resolved)).sort()) await inspect(join(relative, name), true);
        return;
      }
      if (!info.isFile()) throw new Error("Legacy source must be a regular file");
      bytes += info.size;
      if (bytes > 10_000_000 || files.size >= 500) throw new Error("Legacy import exceeds bounded file budget");
      const data = await readFile(resolved);
      if (data.length !== info.size) throw new Error("Legacy source changed during import; retry with stable files");
      files.set(relative, data);
    }
    for (const name of ["schedules/tasks.json", "memory/preferences.json", "memory/feedback.jsonl", "events/queue.jsonl", "events/runs.jsonl"]) await inspect(name);
    await inspect("digests", true);
    if (!files.has("schedules/tasks.json")) throw new Error("No legacy docs/agent/schedules/tasks.json found");
    const manifest = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, hash: hash(data), bytes: data.length }));
    const manifestHash = hash(JSON.stringify(manifest));
    const sourceKey = hash(root);
    const prior = host.store.database.sqlite.prepare("select manifest_hash,receipt_json from legacy_task_imports where source_key=?").get(sourceKey);
    if (prior) {
      const row = z.object({ manifest_hash: z.string(), receipt_json: z.string() }).parse(prior);
      if (row.manifest_hash !== manifestHash) throw new Error("Legacy source changed after import; reconcile explicitly before another import");
      return receiptSchema.parse(JSON.parse(row.receipt_json));
    }
    const legacy = legacySchema.parse(JSON.parse(files.get("schedules/tasks.json")!.toString("utf8")));
    const profileFile = files.get("memory/preferences.json");
    const profile = profileFile ? profileSchema.parse(JSON.parse(profileFile.toString("utf8"))) : undefined;
    const definitions = legacy.tasks.map((task) => contentTaskSchema.parse({
      id: normalizeTaskId(task.id), title: task.title, instruction: task.source.query || "Select valuable content with grounded summaries and exact source quotes.",
      mode: task.source.kind === "mock" ? "demo" : "live", model: task.source.kind === "mock" ? "demo-faux" : host.env.DEEPSEEK_MODEL,
      sources: [task.source.kind === "mock" ? { id: "mock", kind: "mock", url: "https://example.test/demo", ...(task.source.query ? { query: task.source.query } : {}) } : { id: task.source.kind, kind: task.source.kind, url: task.source.url }],
    }));
    if (new Set(definitions.map((task) => task.id)).size !== definitions.length) throw new Error("Legacy task IDs collide after normalization");
    for (const task of definitions) {
      if (task.mode === "demo" && host.env.NODE_ENV === "production") throw new Error("Demo import is disabled in production");
      for (const source of task.sources) if (source.kind !== "mock") await host.store.network.validate(source.url);
    }
    const receipt: LegacyImportReceipt = { manifestHash, files: manifest, mapping: legacy.tasks.map((task, index) => ({ legacyId: task.id, taskId: definitions[index].id })),
      quarantinedFeedback: (files.get("memory/feedback.jsonl")?.toString("utf8") ?? "").split(/\r?\n/).filter((line) => line.trim()).length,
      historicalFiles: manifest.filter((file) => /^(events|digests)\//.test(file.path)).map((file) => file.path),
      policy: "Configuration only; schedules paused. Original files preserved. Legacy feedback/history are not imported into trusted runtime evidence." };
    return host.store.database.sqlite.transaction(() => {
      if (host.store.database.sqlite.prepare("select 1 from legacy_task_imports where source_key=?").get(sourceKey)) throw new Error("Concurrent import completed; retry to read its receipt");
      if (profile && host.store.database.sqlite.prepare("select 1 from memory_entries where kind in ('preference','blocked_topic','source_weight') limit 1").get()) throw new Error("Existing preferences conflict with legacy import");
      for (const [index, definition] of definitions.entries()) {
        host.store.saveContentTask(definition, 0);
        const every = legacy.tasks[index].everyMs;
        if (every !== undefined) {
          if (every % 1000 !== 0) throw new Error("Legacy interval must use whole seconds");
          const cron = `every ${every / 1000}s`;
          host.store.createScheduleSync({ id: `cli-${definition.id}`, taskId: definition.id, title: definition.title, enabled: false, cron, timezone: "UTC", overlapPolicy: "queue", nextRunAt: nextRunAt({ cron, timezone: "UTC" }, runtime.now ?? new Date()) });
        }
      }
      if (profile) host.store.memory.replacePreferences(profile, host.identity.id);
      const redacted = receiptSchema.parse(host.store.redactor.value(receipt));
      host.store.database.sqlite.prepare("insert into legacy_task_imports values (?,?,?,?,?)").run(sourceKey, manifestHash, JSON.stringify(redacted), host.identity.id, new Date().toISOString());
      return redacted;
    }).immediate();
  } catch (error) { throw new Error(host.store.redactor.text(error instanceof Error ? error.message : "Legacy import failed")); }
  finally { await host.close(); }
}
