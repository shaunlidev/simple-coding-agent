import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type ScriptResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runCommand(command: string, args: readonly string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<ScriptResult> {
  const child = spawn(command, args, { cwd: options.cwd ?? process.cwd(), env: { ...process.env, ...(options.env ?? {}) } });
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

test("dashboard vite build contains agent ops cockpit and runtime API wiring", async () => {
  const result = await runCommand("npm", ["run", "dashboard:build"], {
    cwd: process.cwd(),
  });
  assert.equal(result.code, 0, result.stderr);

  const dist = join(process.cwd(), "packages", "dashboard", "dist");
  const assets = join(dist, "assets");
  const html = new TextDecoder().decode(await readFile(join(dist, "index.html")));
  const assetFiles = await readdir(assets);
  const builtText = [
    html,
    ...(await Promise.all(
      assetFiles
        .filter((file) => file.endsWith(".js") || file.endsWith(".css"))
        .map(async (file) => new TextDecoder().decode(await readFile(join(assets, file)))),
    )),
  ].join("\n");

  assert.equal(html.includes("src/main.tsx"), false);
  assert.equal(builtText.includes("Agent Operations Dashboard"), true);
  assert.equal(builtText.includes("Run now"), true);
  assert.equal(builtText.includes("Event Stream"), true);
  assert.equal(builtText.includes("Content Pipeline"), true);
  assert.equal(builtText.includes("Delivered"), true);
  assert.equal(builtText.includes("Raw candidates"), true);
  assert.equal(builtText.includes("score"), true);
  assert.equal(builtText.includes("Scheduler"), true);
  assert.equal(builtText.includes("trigger"), true);
  assert.equal(builtText.includes("last"), true);
  assert.equal(builtText.includes("Security"), true);
  assert.equal(builtText.includes("Preference diffs"), true);
  assert.equal(builtText.includes("P50 latency"), true);
  assert.equal(builtText.includes("Tool failures"), true);
  assert.equal(builtText.includes("traceId"), true);
  assert.equal(builtText.includes("spanId"), true);
  assert.equal(builtText.includes("docs/demo"), false);
  assert.equal(builtText.includes("docs/runtime"), false);
  assert.equal(builtText.includes("/api/snapshot"), true);
  assert.equal(builtText.includes("/api/events/stream"), true);
  assert.equal(builtText.includes("/api/runs/run-now"), true);
  assert.equal(builtText.includes("./demo"), false);
});
