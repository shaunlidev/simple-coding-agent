import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../../agent/src/index.ts";
import { createFauxProvider } from "../../ai/src/faux-provider.ts";
import { parseCliArgs, runCli } from "../src/cli.ts";

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
