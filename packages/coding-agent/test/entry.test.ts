import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function runEntry(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", "packages/coding-agent/src/entry.ts", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, DEEPSEEK_API_KEY: "" },
    },
  );
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.from(new Uint8Array(stdout.flatMap((chunk) => [...chunk]))).toString("utf8"),
        stderr: Buffer.from(new Uint8Array(stderr.flatMap((chunk) => [...chunk]))).toString("utf8"),
      });
    });
  });
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
