import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendSessionRecord,
  parseSessionRecord,
  readSessionRecords,
  replaySessionMessages,
  serializeSessionRecord,
  SESSION_RECORD_VERSION,
  type SessionRecord,
} from "../src/session.ts";

test("session records serialize as versioned JSONL", () => {
  const record: SessionRecord = {
    version: SESSION_RECORD_VERSION,
    type: "message",
    message: { role: "user", content: "hello" },
  };

  const line = serializeSessionRecord(record);
  const parsed = JSON.parse(line);

  assert.equal(line.endsWith("\n"), true);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.type, "message");
});

test("session records append and read back in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-session-"));
  const path = join(root, "session.jsonl");

  await appendSessionRecord(path, {
    version: SESSION_RECORD_VERSION,
    type: "message",
    message: { role: "user", content: "hello" },
  });
  await appendSessionRecord(path, {
    version: SESSION_RECORD_VERSION,
    type: "event",
    event: { type: "agent_start", prompt: "hello" },
  });

  const text = new TextDecoder().decode(await readFile(path));
  const records = await readSessionRecords(path);

  assert.equal(text.trim().split("\n").length, 2);
  assert.deepEqual(records.map((record) => record.type), ["message", "event"]);
});

test("session replay extracts message history only", () => {
  const records: SessionRecord[] = [
    { version: SESSION_RECORD_VERSION, type: "message", message: { role: "user", content: "hello" } },
    { version: SESSION_RECORD_VERSION, type: "event", event: { type: "agent_start", prompt: "hello" } },
    {
      version: SESSION_RECORD_VERSION,
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
    },
  ];

  assert.deepEqual(replaySessionMessages(records), [
    { role: "user", content: "hello" },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] },
  ]);
});

test("session parser rejects unsupported future versions", () => {
  assert.throws(
    () => parseSessionRecord(JSON.stringify({ version: 999, type: "message", message: { role: "user", content: "x" } })),
    /Unsupported session record version: 999/,
  );
});
