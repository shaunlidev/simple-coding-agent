import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "../../ai/src/index.js";

export type ToolRuntimeOptions = {
  allowedRoot: string;
  maxReadBytes?: number;
  commandTimeoutMs?: number;
};

export type ReadArgs = {
  path: string;
  offset?: number;
  limit?: number;
};

export type WriteArgs = {
  path: string;
  content: string;
};

export type EditArgs = {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

export type BashArgs = {
  command: string;
  args?: string[];
  timeoutMs?: number;
};

export type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  signal: string | null;
};

const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

async function resolveInsideRoot(root: string, requestedPath: string, options: { mustExist: boolean }): Promise<string> {
  const rootReal = await realpath(root);
  const absolute = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(rootReal, requestedPath);
  const targetReal = options.mustExist ? await realpath(absolute) : resolve(absolute);
  const relation = relative(rootReal, targetReal);

  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    return targetReal;
  }

  throw new Error(`Path escapes allowed root: ${requestedPath}`);
}

function rejectBinary(bytes: Uint8Array): void {
  if (Buffer.from(bytes).includes(0)) {
    throw new Error("Refusing to read obvious binary file");
  }
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  return value.split(/\r\n|\n|\r/);
}

function takeCompleteLinesWithinBudget(lines: string[], maxBytes: number): string[] {
  const selected: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    const lineBytes = new TextEncoder().encode(`${line}\n`).byteLength;
    if (selected.length === 0 && lineBytes > maxBytes) {
      throw new Error("First line exceeds read byte budget");
    }
    if (bytes + lineBytes > maxBytes) {
      break;
    }
    selected.push(line);
    bytes += lineBytes;
  }

  return selected;
}

export async function readTool(args: ReadArgs, runtime: ToolRuntimeOptions, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);

  const target = await resolveInsideRoot(runtime.allowedRoot, args.path, { mustExist: true });
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error(`Path is not a file: ${args.path}`);
  }

  assertNotAborted(signal);
  const bytes = await readFile(target);
  rejectBinary(bytes);

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = splitLines(text);
  if (lines.length === 0) {
    return "";
  }
  const offset = args.offset ?? 1;
  const limit = args.limit ?? lines.length;

  if (!Number.isInteger(offset) || offset < 1) {
    throw new Error("offset must be a positive 1-indexed integer");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

  const requested = lines.slice(offset - 1, offset - 1 + limit);
  const selected = takeCompleteLinesWithinBudget(requested, runtime.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
  const nextOffset = offset - 1 + selected.length < lines.length ? offset + selected.length : undefined;
  const body = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");

  return nextOffset === undefined ? body : `${body}\n\n[More content available from offset ${nextOffset}]`;
}

export async function writeTool(args: WriteArgs, runtime: ToolRuntimeOptions, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  const target = await resolveInsideRoot(runtime.allowedRoot, args.path, { mustExist: false });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, args.content);
  return `Wrote ${args.path}`;
}

export async function editTool(args: EditArgs, runtime: ToolRuntimeOptions, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  const target = await resolveInsideRoot(runtime.allowedRoot, args.path, { mustExist: true });
  const current = new TextDecoder().decode(await readFile(target));
  const matches = current.split(args.oldText).length - 1;

  if (args.oldText.length === 0) {
    throw new Error("oldText must not be empty");
  }
  if (matches === 0) {
    throw new Error("oldText was not found");
  }
  if (matches > 1 && args.replaceAll !== true) {
    throw new Error("oldText appears multiple times");
  }

  const next = args.replaceAll ? current.split(args.oldText).join(args.newText) : current.replace(args.oldText, args.newText);
  await writeFile(target, next);
  return `Edited ${args.path}`;
}

export async function bashTool(args: BashArgs, runtime: ToolRuntimeOptions, signal?: AbortSignal): Promise<BashResult> {
  assertNotAborted(signal);

  const timeoutMs = args.timeoutMs ?? runtime.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const child = spawn(args.command, args.args ?? [], {
    cwd: await realpath(runtime.allowedRoot),
    shell: false,
    signal: controller.signal,
  });
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];

  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return await new Promise<BashResult>((resolvePromise, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      if (controller.signal.aborted || signal?.aborted) {
        resolvePromise({
          stdout: Buffer.from(new Uint8Array(stdout.flatMap((chunk) => [...chunk]))).toString("utf8"),
          stderr: Buffer.from(new Uint8Array(stderr.flatMap((chunk) => [...chunk]))).toString("utf8"),
          exitCode: null,
          timedOut: !signal?.aborted,
          signal: "SIGTERM",
        });
        return;
      }
      reject(error);
    });
    child.on("close", (code, closeSignal) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.from(new Uint8Array(stdout.flatMap((chunk) => [...chunk]))).toString("utf8"),
        stderr: Buffer.from(new Uint8Array(stderr.flatMap((chunk) => [...chunk]))).toString("utf8"),
        exitCode: code,
        timedOut: controller.signal.aborted && !signal?.aborted,
        signal: closeSignal,
      });
    });
  });
}

export function createLocalTools(runtime: ToolRuntimeOptions): ToolDefinition[] {
  return [
    {
      name: "read",
      description: "Read a UTF-8 text file inside the workspace",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1 },
          offset: { type: "number", minimum: 1 },
          limit: { type: "number", minimum: 1 },
        },
      },
      execute: (args, signal) => readTool(args as ReadArgs, runtime, signal as AbortSignal | undefined),
    },
    {
      name: "write",
      description: "Write a UTF-8 file inside the workspace",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
      },
      execute: (args, signal) => writeTool(args as WriteArgs, runtime, signal as AbortSignal | undefined),
    },
    {
      name: "edit",
      description: "Replace text in a UTF-8 file inside the workspace",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "oldText", "newText"],
        properties: {
          path: { type: "string", minLength: 1 },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
          replaceAll: { type: "boolean" },
        },
      },
      execute: (args, signal) => editTool(args as EditArgs, runtime, signal as AbortSignal | undefined),
    },
    {
      name: "bash",
      description: "Run a command in the workspace",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: { type: "string", minLength: 1 },
          args: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "number", minimum: 1 },
        },
      },
      execute: (args, signal) => bashTool(args as BashArgs, runtime, signal as AbortSignal | undefined),
    },
  ];
}
