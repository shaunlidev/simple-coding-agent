import type { AgentEvent } from "../../agent/dist/index.js";
import type { AssistantContent, AssistantMessage, Message } from "../../ai/dist/index.js";
import {
  appendSessionRecord,
  createDefaultRuntime,
  CliUsageError,
  SESSION_RECORD_VERSION,
  type CliIo,
} from "../../coding-agent/dist/index.js";

export type TuiCommand =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "run";
      prompt: string;
      cwd?: string;
      model?: string;
      thinking?: boolean;
      sessionPath?: string;
    };

export type TuiRunOptions = {
  signal?: AbortSignal;
};

type TuiRuntimeCommand = Extract<TuiCommand, { kind: "run" }> & { kind: "run"; mode: "print" };

type TuiPromptRunner = {
  prompt(prompt: string, options?: { signal?: AbortSignal }): Promise<AssistantMessage>;
  subscribe?(listener: (event: AgentEvent) => void | Promise<void>): () => void;
};

type TuiRuntimeFactory = (command: TuiRuntimeCommand) => TuiPromptRunner | Promise<TuiPromptRunner>;

const VERSION = "0.1.0";
const defaultRuntimeFactory = createDefaultRuntime as unknown as TuiRuntimeFactory;

const USAGE = `Usage: simple-coding-agent-tui [--cwd PATH] [--model MODEL] [--thinking] [--session PATH] <prompt>

Options:
  --help           Show help
  --version, -v    Show version
  --cwd PATH       Limit local tools to a working directory
  --model MODEL    DeepSeek model id
  --thinking       Allow provider thinking when supported
  --session PATH   Append versioned JSONL session records
`;

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantContent, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderEvent(event: AgentEvent): string | undefined {
  if (event.type === "tool_start") {
    return `tool: ${event.toolCall.name} started\n`;
  }
  if (event.type === "tool_end") {
    return `tool: ${event.message.toolName} ${event.message.isError ? "error" : "ok"}\n`;
  }
  if (event.type === "agent_end") {
    return "status: done\n";
  }
  return undefined;
}

function hasSecret(value: string): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY && value.includes(process.env.DEEPSEEK_API_KEY));
}

async function appendSafeSessionMessage(path: string | undefined, message: Message): Promise<void> {
  if (!path) return;
  if (hasSecret(JSON.stringify(message))) {
    throw new Error("Refusing to write session record containing DEEPSEEK_API_KEY");
  }
  await appendSessionRecord(path, { version: SESSION_RECORD_VERSION, type: "message", message });
}

async function appendSafeSessionEvent(path: string | undefined, event: AgentEvent): Promise<void> {
  if (!path) return;
  if (hasSecret(JSON.stringify(event))) {
    throw new Error("Refusing to write session event containing DEEPSEEK_API_KEY");
  }
  await appendSessionRecord(path, { version: SESSION_RECORD_VERSION, type: "event", event });
}

export function parseTuiArgs(argv: readonly string[]): TuiCommand {
  const rest: string[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  let thinking = false;
  let sessionPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
    if (arg === "--thinking") {
      thinking = true;
      continue;
    }
    if (arg === "--cwd" || arg === "--model" || arg === "--session") {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError(`${arg} requires a value`);
      index += 1;
      if (arg === "--cwd") cwd = value;
      if (arg === "--model") model = value;
      if (arg === "--session") sessionPath = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
    rest.push(arg);
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) {
    throw new CliUsageError("A prompt is required for non-interactive TUI mode.");
  }

  return { kind: "run", prompt, cwd, model, thinking, sessionPath };
}

export async function runTui(
  argv: readonly string[],
  io: CliIo,
  createRuntime: TuiRuntimeFactory = defaultRuntimeFactory,
  options: TuiRunOptions = {},
): Promise<number> {
  let command: TuiCommand;
  try {
    command = parseTuiArgs(argv);
  } catch (error) {
    io.stderr.write(`${normalizeError(error)}\n`);
    return 1;
  }

  if (command.kind === "help") {
    io.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === "version") {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    io.stdout.write("Simple Coding Agent TUI\n");
    io.stdout.write(`cwd: ${command.cwd ?? process.cwd()}\n`);
    io.stdout.write(`model: ${command.model ?? "deepseek-v4-pro"}\n`);
    io.stdout.write("status: running\n");
    await appendSafeSessionMessage(command.sessionPath, { role: "user", content: command.prompt });

    const runner: TuiPromptRunner = await createRuntime({
      kind: "run",
      mode: "print",
      prompt: command.prompt,
      cwd: command.cwd,
      model: command.model,
      thinking: command.thinking,
      sessionPath: command.sessionPath,
    });
    const unsubscribe = runner.subscribe?.((event) => {
      const line = renderEvent(event);
      if (line) io.stdout.write(line);
      return appendSafeSessionEvent(command.sessionPath, event);
    });

    let message: AssistantMessage;
    try {
      message = await runner.prompt(command.prompt, { signal: options.signal });
    } finally {
      unsubscribe?.();
    }
    await appendSafeSessionMessage(command.sessionPath, message);

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      io.stdout.write(`status: ${message.stopReason}\n`);
      io.stderr.write(`${message.errorMessage ?? (assistantText(message) || "Agent failed")}\n`);
      return message.stopReason === "aborted" ? 130 : 1;
    }

    io.stdout.write(`assistant: ${assistantText(message)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${normalizeError(error)}\n`);
    return 1;
  }
}

export const tuiPackageReady = true;
