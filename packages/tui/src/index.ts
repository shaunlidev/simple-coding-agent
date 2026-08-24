import type { AgentEvent } from "../../agent/dist/index.js";
import type { AssistantContent, AssistantMessage, Message, StreamEvent } from "../../ai/dist/index.js";
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
      kind: "interactive";
      cwd?: string;
      model?: string;
      thinking?: boolean;
      sessionPath?: string;
    }
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
  input?: TuiInput;
};

type TuiRuntimeCommand = Extract<TuiCommand, { kind: "run" }> & { kind: "run"; mode: "print" };
type TuiInteractiveCommand = Extract<TuiCommand, { kind: "interactive" }>;

type TuiPromptRunner = {
  prompt(prompt: string, options?: { signal?: AbortSignal }): Promise<AssistantMessage>;
  subscribe?(listener: (event: AgentEvent) => void | Promise<void>): () => void;
};

type TuiRuntimeFactory = (command: TuiRuntimeCommand) => TuiPromptRunner | Promise<TuiPromptRunner>;
export type TuiInput = {
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  close?(): void;
};

type TuiState = {
  cwd?: string;
  model?: string;
  thinking?: boolean;
  sessionPath?: string;
};

type TuiRenderState = {
  assistantOpen: boolean;
  streamedText: string;
};

const VERSION = "0.1.0";
const defaultRuntimeFactory = createDefaultRuntime as unknown as TuiRuntimeFactory;

const USAGE = `Usage: simple-coding-agent-tui [--cwd PATH] [--model MODEL] [--thinking] [--session PATH] [prompt]

Options:
  --help           Show help
  --version, -v    Show version
  --cwd PATH       Limit local tools to a working directory
  --model MODEL    DeepSeek model id
  --thinking       Allow provider thinking when supported
  --session PATH   Append versioned JSONL session records

With no prompt, starts interactive mode.

Interactive commands:
  /help            Show interactive commands
  /quit, /exit     Exit
  /clear           Reset conversation context
  /cwd PATH        Change working directory and reset context
  /model MODEL     Change model and reset context
  /thinking on|off Toggle thinking and reset context
  /session PATH    Append future turns to a session JSONL file
`;

const INTERACTIVE_HELP = `Commands:
  /help
  /quit, /exit
  /clear
  /cwd PATH
  /model MODEL
  /thinking on|off
  /session PATH
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

function useColor(): boolean {
  return process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true" && process.stdout.isTTY === true;
}

function color(code: string, text: string): string {
  if (!useColor()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const styles = {
  title: (text: string) => color("1;36", text),
  label: (text: string) => color("1", text),
  dim: (text: string) => color("2", text),
  ok: (text: string) => color("32", text),
  error: (text: string) => color("31", text),
  tool: (text: string) => color("35", text),
};

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

function compact(value: unknown, maxLength = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function ensureAssistantBlock(renderState: TuiRenderState): string {
  if (renderState.assistantOpen) return "";
  renderState.assistantOpen = true;
  return `${styles.label("Agent")}\n  `;
}

function closeAssistantBlock(renderState: TuiRenderState): string {
  if (!renderState.assistantOpen) return "";
  renderState.assistantOpen = false;
  return "\n";
}

function renderProviderEvent(event: StreamEvent, renderState: TuiRenderState): string | undefined {
  if (event.type === "text_delta") {
    renderState.streamedText += event.delta;
    return `${ensureAssistantBlock(renderState)}${event.delta.replace(/\n/g, "\n  ")}`;
  }
  return undefined;
}

function renderEvent(event: AgentEvent, renderState: TuiRenderState): string | undefined {
  if (event.type === "provider_event") {
    return renderProviderEvent(event.event, renderState);
  }
  if (event.type === "tool_start") {
    return `${closeAssistantBlock(renderState)}${styles.label("Tools")}\n  ${styles.tool("[start]")} ${event.toolCall.name} ${styles.dim(compact(event.toolCall.arguments))}\n`;
  }
  if (event.type === "tool_end") {
    const status = event.message.isError ? styles.error("[error]") : styles.ok("[ok]");
    const summary = compact(event.message.content.replace(/\s+/g, " "));
    return `  ${status} ${event.message.toolName}${summary ? ` ${styles.dim(summary)}` : ""}\n`;
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
  if (!prompt) return { kind: "interactive", cwd, model, thinking, sessionPath };

  return { kind: "run", prompt, cwd, model, thinking, sessionPath };
}

function writeHeader(io: CliIo, state: TuiState): void {
  io.stdout.write(`${styles.title("Simple Coding Agent")}\n`);
  io.stdout.write(`${styles.dim("cwd")}      ${state.cwd ?? process.cwd()}\n`);
  io.stdout.write(`${styles.dim("model")}    ${state.model ?? "deepseek-v4-pro"}\n`);
  io.stdout.write(`${styles.dim("thinking")} ${state.thinking ? "on" : "off"}\n`);
  io.stdout.write(`${styles.dim("session")}  ${state.sessionPath ?? "(none)"}\n\n`);
}

function commandFromState(prompt: string, state: TuiState): TuiRuntimeCommand {
  return {
    kind: "run",
    mode: "print",
    prompt,
    cwd: state.cwd,
    model: state.model,
    thinking: state.thinking,
    sessionPath: state.sessionPath,
  };
}

async function runPromptTurn(
  prompt: string,
  state: TuiState,
  io: CliIo,
  runner: TuiPromptRunner,
  options: { signal?: AbortSignal } = {},
): Promise<{ code: number; message?: AssistantMessage }> {
  const renderState: TuiRenderState = { assistantOpen: false, streamedText: "" };
  io.stdout.write(`${styles.label("You")}\n${indent(prompt)}\n\n`);
  io.stdout.write(`${styles.dim("status")} running\n`);
  await appendSafeSessionMessage(state.sessionPath, { role: "user", content: prompt });

  const unsubscribe = runner.subscribe?.((event) => {
    const line = renderEvent(event, renderState);
    if (line) io.stdout.write(line);
    return appendSafeSessionEvent(state.sessionPath, event);
  });

  let message: AssistantMessage;
  try {
    message = await runner.prompt(prompt, { signal: options.signal });
  } finally {
    unsubscribe?.();
  }
  await appendSafeSessionMessage(state.sessionPath, message);

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    io.stdout.write(closeAssistantBlock(renderState));
    io.stdout.write(`${styles.dim("status")} ${message.stopReason === "error" ? styles.error("error") : "aborted"}\n`);
    io.stderr.write(`${message.errorMessage ?? (assistantText(message) || "Agent failed")}\n`);
    return { code: message.stopReason === "aborted" ? 130 : 1, message };
  }

  const finalText = assistantText(message);
  if (renderState.streamedText.length === 0 && finalText) {
    io.stdout.write(`${ensureAssistantBlock(renderState)}${finalText.replace(/\n/g, "\n  ")}`);
  }
  io.stdout.write(closeAssistantBlock(renderState));
  io.stdout.write(`${styles.dim("status")} ${styles.ok("done")}\n\n`);
  return { code: 0, message };
}

async function runOneShotTui(
  command: Extract<TuiCommand, { kind: "run" }>,
  io: CliIo,
  createRuntime: TuiRuntimeFactory,
  options: TuiRunOptions,
): Promise<number> {
  try {
    const state: TuiState = {
      cwd: command.cwd,
      model: command.model,
      thinking: command.thinking,
      sessionPath: command.sessionPath,
    };
    writeHeader(io, state);

    const runner: TuiPromptRunner = await createRuntime(commandFromState(command.prompt, state));
    const result = await runPromptTurn(command.prompt, state, io, runner, { signal: options.signal });
    return result.code;
  } catch (error) {
    io.stderr.write(`${normalizeError(error)}\n`);
    return 1;
  }
}

function createRuntimeResetMessage(state: TuiState): string {
  return `${styles.dim("cwd")}      ${state.cwd ?? process.cwd()}\n${styles.dim("model")}    ${state.model ?? "deepseek-v4-pro"}\n${styles.dim("thinking")} ${state.thinking ? "on" : "off"}\n${styles.dim("session")}  ${state.sessionPath ?? "(none)"}\n`;
}

function parseOnOff(value: string | undefined): boolean | undefined {
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return undefined;
}

async function runInteractiveCommand(
  line: string,
  state: TuiState,
  io: CliIo,
): Promise<"continue" | "quit" | "reset"> {
  const [name = "", ...rest] = line.trim().split(/\s+/);
  const value = rest.join(" ").trim();

  if (name === "/quit" || name === "/exit") return "quit";
  if (name === "/help") {
    io.stdout.write(INTERACTIVE_HELP);
    return "continue";
  }
  if (name === "/clear") {
    io.stdout.write(`${styles.dim("status")} context cleared\n`);
    return "reset";
  }
  if (name === "/cwd") {
    if (!value) {
      io.stderr.write("/cwd requires a path\n");
      return "continue";
    }
    state.cwd = value;
    io.stdout.write(createRuntimeResetMessage(state));
    return "reset";
  }
  if (name === "/model") {
    if (!value) {
      io.stderr.write("/model requires a model id\n");
      return "continue";
    }
    state.model = value;
    io.stdout.write(createRuntimeResetMessage(state));
    return "reset";
  }
  if (name === "/thinking") {
    const next = parseOnOff(value);
    if (next === undefined) {
      io.stderr.write("/thinking requires on or off\n");
      return "continue";
    }
    state.thinking = next;
    io.stdout.write(createRuntimeResetMessage(state));
    return "reset";
  }
  if (name === "/session") {
    if (!value) {
      io.stderr.write("/session requires a path\n");
      return "continue";
    }
    state.sessionPath = value;
    io.stdout.write(`${styles.dim("session")}  ${state.sessionPath}\n`);
    return "continue";
  }

  io.stderr.write(`Unknown command: ${name}\n`);
  return "continue";
}

async function createDefaultInput(): Promise<TuiInput> {
  const readline = await import("node:readline");
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const iterator = readlineInterface[Symbol.asyncIterator]();
  return {
    async question(prompt, options) {
      if (options?.signal?.aborted) return undefined;
      process.stdout.write(prompt);
      const next = await iterator.next();
      return next.done ? undefined : next.value;
    },
    close() {
      readlineInterface.close();
    },
  };
}

async function runInteractiveTui(
  command: TuiInteractiveCommand,
  io: CliIo,
  createRuntime: TuiRuntimeFactory,
  options: TuiRunOptions,
): Promise<number> {
  const state: TuiState = {
    cwd: command.cwd,
    model: command.model,
    thinking: command.thinking,
    sessionPath: command.sessionPath,
  };

  const input = options.input ?? (await createDefaultInput());
  let runner: TuiPromptRunner | undefined;
  let turn = 0;

  writeHeader(io, state);
  io.stdout.write("type /help for commands\n");

  try {
    while (true) {
      const line = await input.question("> ", { signal: options.signal });
      if (line === undefined) return 0;
      const prompt = line.trim();
      if (!prompt) continue;

      if (prompt.startsWith("/")) {
        const result = await runInteractiveCommand(prompt, state, io);
        if (result === "quit") return 0;
        if (result === "reset") runner = undefined;
        continue;
      }

      turn += 1;
      io.stdout.write(`\n${styles.label(`Turn ${turn}`)}\n`);
      runner ??= await createRuntime(commandFromState(prompt, state));
      const result = await runPromptTurn(prompt, state, io, runner, { signal: options.signal });
      if (result.code === 130) return 130;
    }
  } catch (error) {
    if (options.signal?.aborted) {
      io.stdout.write("status: aborted\n");
      return 130;
    }
    io.stderr.write(`${normalizeError(error)}\n`);
    return 1;
  } finally {
    input.close?.();
  }
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

  if (command.kind === "interactive") {
    return runInteractiveTui(command, io, createRuntime, options);
  }

  return runOneShotTui(command, io, createRuntime, options);
}

export const tuiPackageReady = true;
