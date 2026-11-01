import {
  createScheduledTask,
  formatTaskList,
  listScheduledTasks,
  recordTaskFeedback,
  runDueTasks,
  runScheduledTask,
  updatePreferences,
  type CreateTaskArgs,
  type FeedbackSignal,
  type SourceKind,
  type TaskRuntimeOptions,
} from "./tasks.js";
import type { CliIo } from "./cli.js";

export type TaskCliCommand =
  | { kind: "help" }
  | { kind: "create"; args: CreateTaskArgs; cwd?: string }
  | { kind: "list"; cwd?: string }
  | { kind: "run"; id: string; cwd?: string }
  | { kind: "run-due"; cwd?: string }
  | { kind: "daemon"; cwd?: string; intervalMs: number; once?: boolean }
  | { kind: "feedback"; taskId: string; itemId: string; signal: FeedbackSignal; cwd?: string }
  | { kind: "preferences"; interests?: string[]; blockedTopics?: string[]; cwd?: string };

const USAGE = `Usage: simple-coding-agent-task <command> [options]

Commands:
  create ID [--title TITLE] [--every 6h] [--source mock|browser|rss] [--url URL] [--query TEXT]
  list
  run ID
  run-due
  daemon [--interval-ms 60000] [--once]
  feedback TASK_ID ITEM_ID clicked|saved|not_interested|dismissed
  preferences [--interests a,b] [--blocked-topics x,y]

Options:
  --cwd PATH       Store docs/agent state under PATH
  --help          Show help
`;

export class TaskCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskCliUsageError";
  }
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function takeOption(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value) throw new TaskCliUsageError(`${name} requires a value`);
  return value;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length === 0 ? undefined : items;
}

function requireSource(value: string): SourceKind {
  if (value === "mock" || value === "browser" || value === "rss") return value;
  throw new TaskCliUsageError(`Unknown source: ${value}`);
}

function requireSignal(value: string): FeedbackSignal {
  if (value === "clicked" || value === "saved" || value === "not_interested" || value === "dismissed") return value;
  throw new TaskCliUsageError(`Unknown feedback signal: ${value}`);
}

export function parseTaskCliArgs(argv: readonly string[]): TaskCliCommand {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") return { kind: "help" };
  let cwd: string | undefined;
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--cwd") {
      cwd = takeOption(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg.startsWith("--")) {
      options[arg.slice(2)] = takeOption(rest, index, arg);
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  if (command === "create") {
    const id = positional[0];
    if (!id) throw new TaskCliUsageError("create requires ID");
    return {
      kind: "create",
      cwd,
      args: {
        id,
        title: typeof options.title === "string" ? options.title : undefined,
        every: typeof options.every === "string" ? options.every : undefined,
        source: typeof options.source === "string" ? requireSource(options.source) : undefined,
        url: typeof options.url === "string" ? options.url : undefined,
        query: typeof options.query === "string" ? options.query : undefined,
      },
    };
  }
  if (command === "list") return { kind: "list", cwd };
  if (command === "run") {
    if (!positional[0]) throw new TaskCliUsageError("run requires ID");
    return { kind: "run", id: positional[0], cwd };
  }
  if (command === "run-due") return { kind: "run-due", cwd };
  if (command === "daemon") {
    const intervalMs = typeof options["interval-ms"] === "string" ? Number(options["interval-ms"]) : 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new TaskCliUsageError("--interval-ms must be a positive number");
    return { kind: "daemon", cwd, intervalMs, once: options.once === true };
  }
  if (command === "feedback") {
    const [taskId, itemId, signal] = positional;
    if (!taskId || !itemId || !signal) throw new TaskCliUsageError("feedback requires TASK_ID ITEM_ID SIGNAL");
    return { kind: "feedback", taskId, itemId, signal: requireSignal(signal), cwd };
  }
  if (command === "preferences") {
    return {
      kind: "preferences",
      cwd,
      interests: splitCsv(typeof options.interests === "string" ? options.interests : undefined),
      blockedTopics: splitCsv(typeof options["blocked-topics"] === "string" ? options["blocked-topics"] : undefined),
    };
  }
  throw new TaskCliUsageError(`Unknown command: ${command}`);
}

function runtimeFor(command: { cwd?: string }): TaskRuntimeOptions {
  return { allowedRoot: command.cwd ?? process.cwd() };
}

export async function runTaskCli(argv: readonly string[], io: CliIo): Promise<number> {
  let command: TaskCliCommand;
  try {
    command = parseTaskCliArgs(argv);
  } catch (error) {
    io.stderr.write(`${normalizeError(error)}\n`);
    return 1;
  }

  try {
    if (command.kind === "help") {
      io.stdout.write(USAGE);
      return 0;
    }
    if (command.kind === "create") {
      const task = await createScheduledTask(command.args, runtimeFor(command));
      io.stdout.write(`Created task ${task.id}\n`);
      return 0;
    }
    if (command.kind === "list") {
      io.stdout.write(`${formatTaskList(await listScheduledTasks(runtimeFor(command)))}\n`);
      return 0;
    }
    if (command.kind === "run") {
      const result = await runScheduledTask(command.id, runtimeFor(command));
      io.stdout.write(`Ran ${result.taskId}: ${result.itemCount} items\nDigest: ${result.digestPath}\n`);
      return 0;
    }
    if (command.kind === "run-due") {
      const results = await runDueTasks(runtimeFor(command));
      io.stdout.write(`Ran ${results.length} due task(s)\n`);
      return 0;
    }
    if (command.kind === "daemon") {
      do {
        const results = await runDueTasks(runtimeFor(command));
        io.stdout.write(`${new Date().toISOString()} ran ${results.length} due task(s)\n`);
        if (command.once) return 0;
        await new Promise((resolve) => setTimeout(resolve, command.intervalMs));
      } while (true);
    }
    if (command.kind === "feedback") {
      await recordTaskFeedback(command, runtimeFor(command));
      io.stdout.write(`Recorded ${command.signal} for ${command.itemId}\n`);
      return 0;
    }
    if (command.kind === "preferences") {
      const memory = await updatePreferences(runtimeFor(command), {
        ...(command.interests ? { interests: command.interests } : {}),
        ...(command.blockedTopics ? { blockedTopics: command.blockedTopics } : {}),
      });
      io.stdout.write(`Updated preferences: ${memory.interests.join(", ")}\n`);
      return 0;
    }
    return 1;
  } catch (error) {
    io.stderr.write(`${normalizeError(error)}\n`);
    return 1;
  }
}
