import { spawn } from "node:child_process";

export type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export function runNodeEntry(
  entry: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<ProcessResult> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", entry, ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
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
