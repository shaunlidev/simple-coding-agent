import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTuiArgs, runTui, type TuiInput } from "../src/index.ts";

function createIo(): { output: { stdout: string; stderr: string }; io: { stdout: { write(chunk: string): void }; stderr: { write(chunk: string): void } } } {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    io: {
      stdout: { write: (chunk: string) => (output.stdout += chunk) },
      stderr: { write: (chunk: string) => (output.stderr += chunk) },
    },
  };
}

function createInput(lines: readonly string[]): TuiInput & { closed: boolean } {
  const pending = [...lines];
  return {
    closed: false,
    async question() {
      return pending.shift();
    },
    close() {
      this.closed = true;
    },
  };
}

test("parseTuiArgs supports static and run commands", () => {
  assert.deepEqual(parseTuiArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseTuiArgs(["--version"]), { kind: "version" });
  assert.deepEqual(parseTuiArgs([]), {
    kind: "interactive",
    cwd: undefined,
    model: undefined,
    thinking: false,
    sessionPath: undefined,
  });
  assert.deepEqual(parseTuiArgs(["--cwd", "/tmp/work", "--model", "deepseek-v4-flash", "--thinking", "do", "it"]), {
    kind: "run",
    prompt: "do it",
    cwd: "/tmp/work",
    model: "deepseek-v4-flash",
    thinking: true,
    sessionPath: undefined,
  });
});

test("static TUI commands do not initialize runtime", async () => {
  const { output, io } = createIo();

  assert.equal(await runTui(["--help"], io, () => {
    throw new Error("runtime should not initialize");
  }), 0);
  assert.equal(output.stderr, "");
  assert.equal(output.stdout.includes("simple-coding-agent-tui"), true);
});

test("TUI run mode renders status, tool events, and assistant text", async () => {
  const { output, io } = createIo();
  const listeners = new Set<(event: { type: "tool_start"; turn: number; toolCall: { type: "tool_call"; id: string; name: string; arguments: {} } } | { type: "tool_end"; turn: number; message: { role: "tool"; toolCallId: string; toolName: string; content: string } } | { type: "agent_end"; messages: [] }) => void | Promise<void>>();

  const code = await runTui(
    ["--cwd", "/tmp/work", "--model", "model-a", "hello"],
    io,
    () => ({
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          await listener({
            type: "tool_start",
            turn: 1,
            toolCall: { type: "tool_call", id: "1", name: "read", arguments: {} },
          });
          await listener({
            type: "tool_end",
            turn: 1,
            message: { role: "tool", toolCallId: "1", toolName: "read", content: "ok" },
          });
          await listener({ type: "agent_end", messages: [] });
        }
        return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
      },
    }),
  );

  assert.equal(code, 0);
  assert.equal(output.stderr, "");
  assert.equal(output.stdout.includes("cwd      /tmp/work"), true);
  assert.equal(output.stdout.includes("model    model-a"), true);
  assert.equal(output.stdout.includes("You\n  hello"), true);
  assert.equal(output.stdout.includes("Tools\n  [start] read {}"), true);
  assert.equal(output.stdout.includes("  [ok] read ok"), true);
  assert.equal(output.stdout.includes("Agent\n  done"), true);
  assert.equal(output.stdout.includes("status done"), true);
});

test("TUI streams provider text deltas and does not duplicate final text", async () => {
  const { output, io } = createIo();
  const listeners = new Set<(event: { type: "provider_event"; turn: number; event: { type: "text_delta"; contentIndex: number; delta: string } }) => void | Promise<void>>();

  const code = await runTui(
    ["hello"],
    io,
    () => ({
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          await listener({ type: "provider_event", turn: 1, event: { type: "text_delta", contentIndex: 0, delta: "hel" } });
          await listener({ type: "provider_event", turn: 1, event: { type: "text_delta", contentIndex: 0, delta: "lo" } });
        }
        return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }] };
      },
    }),
  );

  assert.equal(code, 0);
  assert.equal(output.stdout.includes("Agent\n  hello"), true);
  assert.equal(output.stdout.match(/hello/g)?.length, 2);
  assert.equal(output.stdout.includes("assistant: hello"), false);
});

test("interactive TUI reuses one runner for multiple prompts", async () => {
  const { output, io } = createIo();
  const input = createInput(["first", "second", "/quit"]);
  const prompts: string[] = [];
  let runtimes = 0;

  const code = await runTui(
    [],
    io,
    () => {
      runtimes += 1;
      return {
        async prompt(prompt) {
          prompts.push(prompt);
          return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `answer:${prompt}` }] };
        },
      };
    },
    { input },
  );

  assert.equal(code, 0);
  assert.equal(runtimes, 1);
  assert.deepEqual(prompts, ["first", "second"]);
  assert.equal(output.stdout.includes("type /help for commands"), true);
  assert.equal(output.stdout.includes("Turn 1"), true);
  assert.equal(output.stdout.includes("Turn 2"), true);
  assert.equal(output.stdout.includes("Agent\n  answer:first"), true);
  assert.equal(output.stdout.includes("Agent\n  answer:second"), true);
  assert.equal(input.closed, true);
});

test("interactive TUI clear resets runtime for the next prompt", async () => {
  const { output, io } = createIo();
  const input = createInput(["first", "/clear", "second", "/quit"]);
  const promptsByRuntime: string[][] = [];

  const code = await runTui(
    [],
    io,
    () => {
      const prompts: string[] = [];
      promptsByRuntime.push(prompts);
      return {
        async prompt(prompt) {
          prompts.push(prompt);
          return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
        },
      };
    },
    { input },
  );

  assert.equal(code, 0);
  assert.equal(output.stdout.includes("status context cleared"), true);
  assert.deepEqual(promptsByRuntime, [["first"], ["second"]]);
});

test("interactive TUI cwd, model, and thinking commands update the next runtime", async () => {
  const { output, io } = createIo();
  const input = createInput([
    "/cwd /tmp/next",
    "/model model-b",
    "/thinking on",
    "inspect",
    "/quit",
  ]);
  const runtimeCommands: unknown[] = [];

  const code = await runTui(
    [],
    io,
    (command) => {
      runtimeCommands.push(command);
      return {
        async prompt() {
          return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
        },
      };
    },
    { input },
  );

  assert.equal(code, 0);
  assert.equal(output.stdout.includes("cwd      /tmp/next"), true);
  assert.equal(output.stdout.includes("model    model-b"), true);
  assert.equal(output.stdout.includes("thinking on"), true);
  assert.deepEqual(runtimeCommands, [
    {
      kind: "run",
      mode: "print",
      prompt: "inspect",
      cwd: "/tmp/next",
      model: "model-b",
      thinking: true,
      sessionPath: undefined,
    },
  ]);
});

test("TUI session path records prompt, events, and final assistant", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-"));
  const sessionPath = join(root, "session.jsonl");
  const { io } = createIo();
  const listeners = new Set<(event: { type: "agent_end"; messages: [] }) => void | Promise<void>>();

  const code = await runTui(
    ["--session", sessionPath, "hello"],
    io,
    () => ({
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
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
  assert.deepEqual(records.map((record) => record.type), ["message", "event", "message"]);
  assert.deepEqual(records.map((record) => record.version), [1, 1, 1]);
});

test("interactive TUI session path records every prompt and assistant message", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-tui-interactive-"));
  const sessionPath = join(root, "session.jsonl");
  const { io } = createIo();
  const input = createInput(["one", "two", "/quit"]);

  const code = await runTui(
    ["--session", sessionPath],
    io,
    () => ({
      async prompt(prompt) {
        return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `reply ${prompt}` }] };
      },
    }),
    { input },
  );

  const records = new TextDecoder()
    .decode(await readFile(sessionPath))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(code, 0);
  assert.deepEqual(records.map((record) => record.type), ["message", "message", "message", "message"]);
  assert.deepEqual(
    records.map((record) => record.message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.deepEqual(records.map((record) => record.version), [1, 1, 1, 1]);
});

test("TUI reports aborted runs distinctly", async () => {
  const { output, io } = createIo();
  const controller = new AbortController();
  controller.abort();

  const code = await runTui(
    ["hello"],
    io,
    () => ({
      async prompt(_prompt, options) {
        assert.equal(options?.signal?.aborted, true);
        return { role: "assistant", stopReason: "aborted", content: [], errorMessage: "Operation aborted" };
      },
    }),
    { signal: controller.signal },
  );

  assert.equal(code, 130);
  assert.equal(output.stdout.includes("status aborted"), true);
  assert.equal(output.stderr, "Operation aborted\n");
});

test("TUI run mode fails clearly without DeepSeek configuration", async () => {
  const { output, io } = createIo();

  const code = await runTui(["hello"], io, async () => {
    throw new Error("DEEPSEEK_API_KEY is required to run the default DeepSeek runtime");
  });

  assert.equal(code, 1);
  assert.equal(output.stderr, "DEEPSEEK_API_KEY is required to run the default DeepSeek runtime\n");
});
