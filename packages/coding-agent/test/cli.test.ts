import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../../agent/src/index.ts";
import { createFauxProvider } from "../../ai/dist/faux-provider.js";
import { parseCliArgs, runCli } from "../src/cli.ts";
import { SESSION_RECORD_VERSION } from "../src/session.ts";

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "coding-agent-cli-"));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

test("parseCliArgs supports static commands and run modes", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["-v"]), { kind: "version" });
  assert.deepEqual(parseCliArgs(["--mode", "json", "hello", "world"]), {
    kind: "run",
    mode: "json",
    prompt: "hello world",
    cwd: undefined,
    model: undefined,
    thinking: false,
    sessionPath: undefined,
    resumePath: undefined,
  });
  assert.throws(() => parseCliArgs(["--wat"]), /Unknown option: --wat/);
  assert.throws(() => parseCliArgs([]), /A prompt is required/);
});

test("static commands do not initialize runtime", async () => {
  const output = { stdout: "", stderr: "" };
  const io = {
    stdout: { write: (chunk: string) => (output.stdout += chunk) },
    stderr: { write: (chunk: string) => (output.stderr += chunk) },
  };
  const createRuntime = () => {
    throw new Error("runtime should not be created");
  };

  assert.equal(await runCli(["--help"], io, createRuntime), 0);
  assert.equal(await runCli(["--version"], io, createRuntime), 0);
  assert.equal(output.stderr, "");
});

test("print mode writes only final assistant text to stdout", async () => {
  const output = { stdout: "", stderr: "" };
  const io = {
    stdout: { write: (chunk: string) => (output.stdout += chunk) },
    stderr: { write: (chunk: string) => (output.stderr += chunk) },
  };

  const code = await runCli(["--print", "hello"], io, () => ({
    async prompt() {
      return {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "tool_call", id: "1", name: "read", arguments: {} },
          { type: "text", text: "visible" },
        ],
      };
    },
  }));

  assert.equal(code, 0);
  assert.equal(output.stdout, "visible\n");
  assert.equal(output.stderr, "");
});

test("print mode routes structured failure and rejected promises to stderr", async () => {
  const first = { stdout: "", stderr: "" };
  const firstCode = await runCli(
    ["fail"],
    {
      stdout: { write: (chunk: string) => (first.stdout += chunk) },
      stderr: { write: (chunk: string) => (first.stderr += chunk) },
    },
    () => ({
      async prompt() {
        return { role: "assistant", stopReason: "error", content: [], errorMessage: "model failed" };
      },
    }),
  );

  const second = { stdout: "", stderr: "" };
  const secondCode = await runCli(
    ["fail"],
    {
      stdout: { write: (chunk: string) => (second.stdout += chunk) },
      stderr: { write: (chunk: string) => (second.stderr += chunk) },
    },
    () => ({
      async prompt() {
        throw new Error("boom");
      },
    }),
  );

  assert.equal(firstCode, 1);
  assert.equal(first.stdout, "");
  assert.equal(first.stderr, "model failed\n");
  assert.equal(secondCode, 1);
  assert.equal(second.stdout, "");
  assert.equal(second.stderr, "boom\n");
});

test("json mode emits one versioned JSON object per agent event", async () => {
  const output = { stdout: "", stderr: "" };
  const handle = createFauxProvider({ responses: ["done"] });
  const agent = new Agent({ provider: handle.provider });

  const code = await runCli(
    ["--json", "hello"],
    {
      stdout: { write: (chunk: string) => (output.stdout += chunk) },
      stderr: { write: (chunk: string) => (output.stderr += chunk) },
    },
    () => agent,
  );

  const lines = output.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(code, 0);
  assert.equal(output.stderr, "");
  assert.deepEqual(lines.map((line) => line.version).every((version) => version === 1), true);
  assert.equal(lines[0].event.type, "agent_start");
  assert.equal(lines.at(-1).event.type, "agent_end");
});

test("session flag writes versioned prompt, events, and final message records", async () => {
  const root = await createRoot();
  const sessionPath = join(root, "session.jsonl");
  const output = { stdout: "", stderr: "" };
  const listeners = new Set<(event: { type: "agent_start"; prompt: string } | { type: "agent_end"; messages: [] }) => void | Promise<void>>();

  const code = await runCli(
    ["--session", sessionPath, "hello"],
    {
      stdout: { write: (chunk: string) => (output.stdout += chunk) },
      stderr: { write: (chunk: string) => (output.stderr += chunk) },
    },
    () => ({
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(prompt) {
        for (const listener of listeners) await listener({ type: "agent_start", prompt });
        for (const listener of listeners) await listener({ type: "agent_end", messages: [] });
        return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
      },
    }),
  );

  const records = new TextDecoder()
    .decode(await readFile(sessionPath))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(code, 0);
  assert.deepEqual(records.map((record) => record.version), [
    SESSION_RECORD_VERSION,
    SESSION_RECORD_VERSION,
    SESSION_RECORD_VERSION,
    SESSION_RECORD_VERSION,
  ]);
  assert.deepEqual(records.map((record) => record.type), ["message", "event", "event", "message"]);
});

test("resume flag replays session messages before runtime creation", async () => {
  const root = await createRoot();
  const sessionPath = join(root, "session.jsonl");
  await writeFile(
    sessionPath,
    [
      JSON.stringify({ version: 1, type: "message", message: { role: "user", content: "earlier" } }),
      JSON.stringify({
        version: 1,
        type: "message",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "seen" }] },
      }),
      "",
    ].join("\n"),
  );

  let initialCount = 0;
  const code = await runCli(
    ["--resume", sessionPath, "next"],
    {
      stdout: { write() {} },
      stderr: { write() {} },
    },
    (command) => {
      initialCount = command.initialMessages?.length ?? 0;
      return {
        async prompt() {
          return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] };
        },
      };
    },
  );

  assert.equal(code, 0);
  assert.equal(initialCount, 2);
});

test("future-version resume file fails before provider initialization", async () => {
  const root = await createRoot();
  const sessionPath = join(root, "future.jsonl");
  const output = { stdout: "", stderr: "" };
  let initialized = false;
  await writeFile(sessionPath, `${JSON.stringify({ version: 999, type: "message", message: { role: "user", content: "x" } })}\n`);

  const code = await runCli(
    ["--resume", sessionPath, "next"],
    {
      stdout: { write: (chunk: string) => (output.stdout += chunk) },
      stderr: { write: (chunk: string) => (output.stderr += chunk) },
    },
    () => {
      initialized = true;
      throw new Error("should not initialize");
    },
  );

  assert.equal(code, 1);
  assert.equal(initialized, false);
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, "Unsupported session record version: 999\n");
});

test("session redaction refuses to serialize the active DeepSeek key", async () => {
  const root = await createRoot();
  const sessionPath = join(root, "session.jsonl");
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "live-secret";

  try {
    const output = { stdout: "", stderr: "" };
    const code = await runCli(
      ["--session", sessionPath, "hello"],
      {
        stdout: { write: (chunk: string) => (output.stdout += chunk) },
        stderr: { write: (chunk: string) => (output.stderr += chunk) },
      },
      () => ({
        async prompt() {
          return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "live-secret" }] };
        },
      }),
    );

    assert.equal(code, 1);
    assert.equal(output.stdout, "");
    assert.equal(output.stderr.includes("live-secret"), false);
  } finally {
    process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("default runtime requests DeepSeek streaming and emits deltas before body completion", async () => {
  const { createDefaultRuntime } = await import("../src/cli.ts");
  const encoder = new TextEncoder();
  const secondChunk = deferred();
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  let waitingForSecondChunk = false;

  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`));
        },
        async pull(controller) {
          if (waitingForSecondChunk) return;
          waitingForSecondChunk = true;
          await secondChunk.promise;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: "stop" }] })}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const runner = await createDefaultRuntime({ kind: "run", mode: "json", prompt: "hello" });
    const seen: string[] = [];
    const unsubscribe = runner.subscribe?.((event) => {
      if (event.type === "provider_event" && event.event.type === "text_delta") {
        seen.push(event.event.delta);
      }
    });
    const promptPromise = runner.prompt("hello");

    while (seen.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(requestBody?.stream, true);
    assert.deepEqual(seen, ["hi"]);
    assert.equal(waitingForSecondChunk, true);

    secondChunk.resolve();
    const message = await promptPromise;
    unsubscribe?.();

    assert.deepEqual(message.content, [{ type: "text", text: "hi!" }]);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.DEEPSEEK_API_KEY = previousKey;
  }
});
