import type { AgentEvent } from "../../agent/dist/index.js";
import type { AssistantContent, AssistantMessage, Message } from "../../ai/dist/index.js";
import {
  appendSessionRecord,
  readSessionRecords,
  replaySessionMessages,
  SESSION_RECORD_VERSION,
} from "./session.js";
import { createLocalTools } from "./tools.js";

export type CliMode = "print" | "json";

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "run";
      mode: CliMode;
      prompt: string;
      cwd?: string;
      model?: string;
      thinking?: boolean;
      sessionPath?: string;
      resumePath?: string;
      initialMessages?: readonly Message[];
    };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type CliIo = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type PromptRunner = {
  prompt(prompt: string, options?: { signal?: AbortSignal }): Promise<AssistantMessage>;
  subscribe?(listener: (event: AgentEvent) => void | Promise<void>): () => void;
};

export type CliRuntimeFactory = (command: Extract<CliCommand, { kind: "run" }>) => PromptRunner | Promise<PromptRunner>;

export const VERSION = "0.1.0";

const USAGE = `Usage: simple-coding-agent [--print|--json|--mode json] [--cwd PATH] [--model MODEL] [--thinking] [--session PATH] [--resume PATH] <prompt>

Options:
  --help           Show help
  --version, -v    Show version
  --print          Print final assistant text
  --json           Emit JSONL agent events
  --mode MODE      Use print or json mode
  --cwd PATH       Limit local tools to a working directory
  --model MODEL    DeepSeek model id
  --thinking       Allow provider thinking when supported
  --session PATH   Append versioned JSONL session records
  --resume PATH    Replay message records from a session JSONL file
`;

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const rest: string[] = [];
  let mode: CliMode = "print";
  let cwd: string | undefined;
  let model: string | undefined;
  let thinking = false;
  let sessionPath: string | undefined;
  let resumePath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
    if (arg === "--print") {
      mode = "print";
      continue;
    }
    if (arg === "--json") {
      mode = "json";
      continue;
    }
    if (arg === "--thinking") {
      thinking = true;
      continue;
    }
    if (arg === "--cwd" || arg === "--model" || arg === "--mode" || arg === "--session" || arg === "--resume") {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError(`${arg} requires a value`);
      index += 1;
      if (arg === "--cwd") cwd = value;
      if (arg === "--model") model = value;
      if (arg === "--session") sessionPath = value;
      if (arg === "--resume") resumePath = value;
      if (arg === "--mode") {
        if (value !== "print" && value !== "json") {
          throw new CliUsageError(`Unknown mode: ${value}`);
        }
        mode = value;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
    rest.push(arg);
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) {
    throw new CliUsageError("A prompt is required.");
  }

  return { kind: "run", mode, prompt, cwd, model, thinking, sessionPath, resumePath };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantContent, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJsonLine(io: CliIo, event: AgentEvent): void {
  io.stdout.write(`${JSON.stringify({ version: 1, event })}\n`);
}

function hasSecret(value: string): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY && value.includes(process.env.DEEPSEEK_API_KEY));
}

async function appendSafeSessionMessage(path: string | undefined, message: Message): Promise<void> {
  if (!path) return;
  const serialized = JSON.stringify(message);
  if (hasSecret(serialized)) {
    throw new Error("Refusing to write session record containing DEEPSEEK_API_KEY");
  }
  await appendSessionRecord(path, { version: SESSION_RECORD_VERSION, type: "message", message });
}

async function appendSafeSessionEvent(path: string | undefined, event: AgentEvent): Promise<void> {
  if (!path) return;
  const serialized = JSON.stringify(event);
  if (hasSecret(serialized)) {
    throw new Error("Refusing to write session event containing DEEPSEEK_API_KEY");
  }
  await appendSessionRecord(path, { version: SESSION_RECORD_VERSION, type: "event", event });
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  createRuntime: CliRuntimeFactory = createDefaultRuntime,
): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
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

  const runCommand = command;
  try {
    const initialMessages = runCommand.resumePath
      ? replaySessionMessages(await readSessionRecords(runCommand.resumePath))
      : undefined;
    const hydratedCommand = { ...runCommand, initialMessages };
    await appendSafeSessionMessage(hydratedCommand.sessionPath, { role: "user", content: hydratedCommand.prompt });
    const runner = await createRuntime(hydratedCommand);
    if (hydratedCommand.mode === "json") {
      const unsubscribe = runner.subscribe?.((event) => {
        writeJsonLine(io, event);
        return appendSafeSessionEvent(hydratedCommand.sessionPath, event);
      });
      try {
        const message = await runner.prompt(hydratedCommand.prompt);
        await appendSafeSessionMessage(hydratedCommand.sessionPath, message);
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          io.stderr.write(`${message.errorMessage ?? (assistantText(message) || "Agent failed")}\n`);
          return 1;
        }
        return 0;
      } finally {
        unsubscribe?.();
      }
    }

    const unsubscribe = runner.subscribe?.((event) => appendSafeSessionEvent(hydratedCommand.sessionPath, event));
    let message: AssistantMessage;
    try {
      message = await runner.prompt(hydratedCommand.prompt);
    } finally {
      unsubscribe?.();
    }
    await appendSafeSessionMessage(hydratedCommand.sessionPath, message);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      io.stderr.write(`${message.errorMessage ?? (assistantText(message) || "Agent failed")}\n`);
      return 1;
    }
    io.stdout.write(`${assistantText(message)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${normalizeError(error)}\n`);
    return 1;
  }
}

export async function createDefaultRuntime(command: Extract<CliCommand, { kind: "run" }>): Promise<PromptRunner> {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required to run the default DeepSeek runtime");
  }

  const [agentModule, aiModule] = await Promise.all([
    import("../../agent/dist/index.js"),
    import("../../ai/dist/index.js"),
  ]);
  const { Agent } = agentModule as unknown as { Agent: new (options: Record<string, unknown>) => PromptRunner };
  const { createDeepSeekProvider } = aiModule as unknown as {
    createDeepSeekProvider(options: {
      model?: string;
      thinking?: boolean;
      stream?: boolean;
    }): { models: readonly unknown[] };
  };
  const provider = createDeepSeekProvider({ model: command.model, thinking: command.thinking, stream: true });
  return new Agent({
    provider,
    model: provider.models[0],
    tools: createLocalTools({ allowedRoot: command.cwd ?? process.cwd() }),
    messages: command.initialMessages ?? [],
  });
}
