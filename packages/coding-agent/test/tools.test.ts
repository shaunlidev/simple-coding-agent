import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { bashTool, editTool, readTool, scrubToolEnvironment, writeTool } from "../src/tools.ts";

async function createRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "simple-agent-tools-"));
}

test("read supports offset, limit, line numbers, and next offset hint", async () => {
  const root = await createRoot();
  await writeFile(join(root, "notes.txt"), "one\ntwo\nthree\nfour\n");

  const output = await readTool({ path: "notes.txt", offset: 2, limit: 2 }, { allowedRoot: root });

  assert.equal(output, "2: two\n3: three\n\n[More content available from offset 4]");
});

test("read rejects root escape through relative and absolute paths", async () => {
  const root = await createRoot();
  const outsideRoot = await createRoot();
  const outside = join(outsideRoot, "secret.txt");
  await writeFile(outside, "secret");

  await assert.rejects(readTool({ path: `../${outsideRoot.split("/").at(-1)}/secret.txt` }, { allowedRoot: root }), /escapes allowed root/);
  await assert.rejects(readTool({ path: outside }, { allowedRoot: root }), /escapes allowed root/);
});

test("read rejects symlink escape when symlinks are available", async () => {
  const root = await createRoot();
  const outsideRoot = await createRoot();
  const outside = join(outsideRoot, "secret.txt");
  await writeFile(outside, "secret");

  try {
    await symlink(outside, join(root, "link.txt"));
  } catch {
    return;
  }

  await assert.rejects(readTool({ path: "link.txt" }, { allowedRoot: root }), /escapes allowed root/);
});

test("read rejects obvious binary files", async () => {
  const root = await createRoot();
  await writeFile(join(root, "binary.bin"), new Uint8Array([65, 0, 66]));

  await assert.rejects(readTool({ path: "binary.bin" }, { allowedRoot: root }), /binary file/);
});

test("read respects UTF-8 byte budget without returning half a line", async () => {
  const root = await createRoot();
  await writeFile(join(root, "utf8.txt"), "éé\nsmall\nlast\n");

  const output = await readTool({ path: "utf8.txt" }, { allowedRoot: root, maxReadBytes: 12 });

  assert.equal(output, "1: éé\n2: small\n\n[More content available from offset 3]");
});

test("read errors clearly when the first line exceeds byte budget", async () => {
  const root = await createRoot();
  await writeFile(join(root, "long.txt"), "very long first line\nsecond\n");

  await assert.rejects(readTool({ path: "long.txt" }, { allowedRoot: root, maxReadBytes: 4 }), /First line exceeds/);
});

test("read handles empty files and files without trailing newline", async () => {
  const root = await createRoot();
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, "plain.txt"), "last line");

  assert.equal(await readTool({ path: "empty.txt" }, { allowedRoot: root }), "");
  assert.equal(await readTool({ path: "plain.txt" }, { allowedRoot: root }), "1: last line");
});

test("write creates parent directories inside root", async () => {
  const root = await createRoot();

  await writeTool({ path: "nested/out.txt", content: "hello" }, { allowedRoot: root });

  assert.equal(await readTool({ path: "nested/out.txt" }, { allowedRoot: root }), "1: hello");
});

test("write rejects symlink parent escape", async () => {
  const root = await createRoot();
  const outside = await createRoot();

  try {
    await symlink(outside, join(root, "linked"));
  } catch {
    return;
  }

  await assert.rejects(
    writeTool({ path: "linked/out.txt", content: "nope" }, { allowedRoot: root }),
    /escapes allowed root/,
  );
});

test("edit fails for missing or repeated oldText unless replaceAll is explicit", async () => {
  const root = await createRoot();
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/file.txt"), "a b a");

  await assert.rejects(editTool({ path: "src/file.txt", oldText: "z", newText: "x" }, { allowedRoot: root }), /not found/);
  await assert.rejects(editTool({ path: "src/file.txt", oldText: "a", newText: "x" }, { allowedRoot: root }), /multiple times/);

  await editTool({ path: "src/file.txt", oldText: "a", newText: "x", replaceAll: true }, { allowedRoot: root });
  assert.equal(await readTool({ path: "src/file.txt" }, { allowedRoot: root }), "1: x b x");
});

test("bash returns stdout, stderr, exit code, and timeout info", async () => {
  const root = await createRoot();

  const result = await bashTool(
    { command: process.execPath, args: ["-e", "console.log('out'); console.error('err'); process.exit(3)"] },
    { allowedRoot: root },
  );

  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test("bash scrubs API keys and keeps ordinary execution working", async () => {
  const root = await createRoot();

  const result = await bashTool(
    {
      command: process.execPath,
      args: ["-e", "console.log(process.env.DEEPSEEK_API_KEY || 'missing'); console.log(Boolean(process.env.PATH))"],
    },
    {
      allowedRoot: root,
      env: {
        PATH: process.env.PATH,
        DEEPSEEK_API_KEY: "secret-value",
        OTHER_TOKEN: "token-value",
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "missing\ntrue\n");
});

test("scrubToolEnvironment keeps safe names and drops common secret names", () => {
  assert.deepEqual(
    scrubToolEnvironment({
      PATH: "/bin",
      HOME: "/tmp/home",
      DEEPSEEK_API_KEY: "secret",
      SERVICE_TOKEN: "secret",
      DATABASE_PASSWORD: "secret",
      NORMAL_VALUE: "hidden by default",
    }),
    { PATH: "/bin", HOME: "/tmp/home" },
  );
});

test("gitignore ignores local env files while allowing the example", async () => {
  const text = new TextDecoder().decode(await readFile(".gitignore"));

  assert.equal(text.includes(".env\n"), true);
  assert.equal(text.includes(".env.*\n"), true);
  assert.equal(text.includes("!.env.example\n"), true);
});

test("tools honor cancellation before async work", async () => {
  const root = await createRoot();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(readTool({ path: "x.txt" }, { allowedRoot: root }, controller.signal), /Operation aborted/);
});
