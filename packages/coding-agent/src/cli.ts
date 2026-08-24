import type { AgentEvent } from "../../agent/src/index.js";
import type { AssistantContent, AssistantMessage } from "../../ai/src/index.js";

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
  prompt(prompt: string): Promise<AssistantMessage>;
  subscribe?(listener: (event: AgentEvent) => void | Promise<void>): () => void;
};

export type CliRuntimeFactory = (command: Extract<CliCommand, { kind: "run" }>) => PromptRunner;

export const VERSION = "0.1.0";

const USAGE = `Usage: simple-coding-agent [--print|--json|--mode json] [--cwd PATH] [--model MODEL] [--thinking] <prompt>

Options:
  --help           Show help
  --version, -v    Show version
  --print          Print final assistant text
  --json           Emit JSONL agent events
  --mode MODE      Use print or json mode
`;

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const rest: string[] = [];
  let mode: CliMode = "print";
  let cwd: string | undefined;
  let model: string | undefined;
  let thinking = false;

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
    if (arg === "--cwd" || arg === "--model" || arg === "--mode") {
      const value = argv[index + 1];
      if (!value) throw new CliUsageError(`${arg} requires a value`);
      index += 1;
      if (arg === "--cwd") cwd = value;
      if (arg === "--model") model = value;
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

  return { kind: "run", mode, prompt, cwd, model, thinking };
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

  try {
    const runner = createRuntime(command);
    if (command.mode === "json") {
      const unsubscribe = runner.subscribe?.((event) => writeJsonLine(io, event));
      try {
        const message = await runner.prompt(command.prompt);
        if (message.stopReason === "error") {
          io.stderr.write(`${message.errorMessage ?? (assistantText(message) || "Agent failed")}\n`);
          return 1;
        }
        return 0;
      } finally {
        unsubscribe?.();
      }
    }

    const message = await runner.prompt(command.prompt);
    if (message.stopReason === "error") {
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

export function createDefaultRuntime(command: Extract<CliCommand, { kind: "run" }>): PromptRunner {
  const listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(prompt) {
      const message: AssistantMessage = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: `Echo: ${prompt}` }],
      };
      const events: AgentEvent[] = [
        { type: "agent_start", prompt },
        { type: "agent_end", messages: [{ role: "user", content: prompt }, message] },
      ];
      for (const event of events) {
        for (const listener of listeners) {
          await listener(event);
        }
      }
      return message;
    },
  };
}
