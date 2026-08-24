import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseTuiArgs, runTui } from "../src/index.ts";

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

test("parseTuiArgs supports static and run commands", () => {
  assert.deepEqual(parseTuiArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseTuiArgs(["--version"]), { kind: "version" });
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
  assert.equal(output.stdout.includes("cwd: /tmp/work"), true);
  assert.equal(output.stdout.includes("model: model-a"), true);
  assert.equal(output.stdout.includes("tool: read started"), true);
  assert.equal(output.stdout.includes("tool: read ok"), true);
  assert.equal(output.stdout.includes("assistant: done"), true);
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
  assert.equal(output.stdout.includes("status: aborted"), true);
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
