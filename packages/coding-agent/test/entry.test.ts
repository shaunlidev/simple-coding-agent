import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function runEntry(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["packages/coding-agent/dist/entry.js", ...args], {
    cwd: process.cwd(),
  });
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

test("real entry handles print and json modes", async () => {
  const print = await runEntry(["--print", "hello"]);
  const json = await runEntry(["--mode", "json", "hello"]);

  assert.equal(print.code, 0);
  assert.equal(print.stdout, "Echo: hello\n");
  assert.equal(print.stderr, "");

  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout.trim().split("\n")[0]).version, 1);
});

test("real entry exits non-zero for unknown options", async () => {
  const result = await runEntry(["--wat"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Unknown option: --wat\n");
});
