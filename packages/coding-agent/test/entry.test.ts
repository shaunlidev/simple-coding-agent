import assert from "node:assert/strict";
import test from "node:test";
import { runNodeEntry } from "./process-harness.ts";

function runEntry(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runNodeEntry("packages/coding-agent/src/entry.ts", args, { DEEPSEEK_API_KEY: "" });
}

test("real entry handles help and version", async () => {
  assert.equal((await runEntry(["--help"])).code, 0);
  assert.equal((await runEntry(["--version"])).stdout, "0.1.0\n");
});

test("real entry requires DeepSeek configuration for runtime modes", async () => {
  const print = await runEntry(["--print", "hello"]);
  const json = await runEntry(["--mode", "json", "hello"]);

  assert.equal(print.code, 1);
  assert.equal(print.stdout, "");
  assert.equal(print.stderr, "DEEPSEEK_API_KEY is required to run the default DeepSeek runtime\n");

  assert.equal(json.code, 1);
  assert.equal(json.stdout, "");
  assert.equal(json.stderr, "DEEPSEEK_API_KEY is required to run the default DeepSeek runtime\n");
});

test("real entry exits non-zero for unknown options", async () => {
  const result = await runEntry(["--wat"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Unknown option: --wat\n");
});
