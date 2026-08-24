import { appendFile, readFile } from "node:fs/promises";
import type { AgentEvent } from "../../agent/dist/index.js";
import type { Message } from "../../ai/dist/index.js";

export const SESSION_RECORD_VERSION = 1;

export type SessionRecord =
  | { version: typeof SESSION_RECORD_VERSION; type: "message"; message: Message }
  | { version: typeof SESSION_RECORD_VERSION; type: "event"; event: AgentEvent };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertVersion(value: Record<string, unknown>): void {
  if (value.version !== SESSION_RECORD_VERSION) {
    throw new Error(`Unsupported session record version: ${String(value.version)}`);
  }
}

function assertMessage(value: unknown): asserts value is Message {
  if (!isObject(value) || typeof value.role !== "string") {
    throw new Error("Invalid session message record");
  }
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "tool") {
    throw new Error(`Invalid session message role: ${value.role}`);
  }
}

function assertEvent(value: unknown): asserts value is AgentEvent {
  if (!isObject(value) || typeof value.type !== "string") {
    throw new Error("Invalid session event record");
  }
}

export function serializeSessionRecord(record: SessionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseSessionRecord(line: string): SessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid session JSONL record: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isObject(parsed)) {
    throw new Error("Invalid session record root");
  }
  assertVersion(parsed);

  if (parsed.type === "message") {
    assertMessage(parsed.message);
    return { version: SESSION_RECORD_VERSION, type: "message", message: parsed.message };
  }
  if (parsed.type === "event") {
    assertEvent(parsed.event);
    return { version: SESSION_RECORD_VERSION, type: "event", event: parsed.event };
  }

  throw new Error(`Invalid session record type: ${String(parsed.type)}`);
}

export async function appendSessionRecord(path: string, record: SessionRecord): Promise<void> {
  await appendFile(path, serializeSessionRecord(record));
}

export async function readSessionRecords(path: string): Promise<SessionRecord[]> {
  const text = new TextDecoder().decode(await readFile(path));
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseSessionRecord(line));
}

export function replaySessionMessages(records: readonly SessionRecord[]): Message[] {
  return records.flatMap((record) => (record.type === "message" ? [record.message] : []));
}
