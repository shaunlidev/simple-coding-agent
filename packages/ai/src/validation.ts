import type {
  AssistantContent,
  JsonObject,
  JsonValue,
  StreamEvent,
} from "./types.js";

type StreamPhase = "idle" | "streaming" | "terminal";

type TextActiveBlock = {
  kind: "text" | "thinking";
  contentIndex: number;
  value: string;
};

type ToolCallActiveBlock = {
  kind: "tool_call";
  contentIndex: number;
  id: string;
  name: string;
  argumentsJson: string;
  sawArgumentsDelta: boolean;
};

type ActiveBlock = TextActiveBlock | ToolCallActiveBlock;

type SequenceState = {
  phase: StreamPhase;
  nextContentIndex: number;
  activeBlock?: ActiveBlock;
  completedContent: AssistantContent[];
};

export class StreamSequenceError extends Error {
  readonly eventType: StreamEvent["type"];
  readonly phase: StreamPhase;

  constructor(eventType: StreamEvent["type"], phase: StreamPhase, detail: string) {
    super(`Invalid stream event "${eventType}" in phase "${phase}": ${detail}`);
    this.name = "StreamSequenceError";
    this.eventType = eventType;
    this.phase = phase;
  }
}

export interface StreamEventValidator {
  accept(event: StreamEvent): void;
}

function reject(event: StreamEvent, state: SequenceState, detail: string): never {
  throw new StreamSequenceError(event.type, state.phase, detail);
}

function assertStartIndex(
  event: StreamEvent,
  state: SequenceState,
  received: number,
): void {
  if (received !== state.nextContentIndex) {
    reject(event, state, `expected contentIndex ${state.nextContentIndex}, received ${received}`);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonDeepEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonDeepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function getExpectedTerminalContent(state: SequenceState): AssistantContent[] {
  const content = [...state.completedContent];
  const active = state.activeBlock;

  if (active?.kind === "text") {
    content.push({ type: "text", text: active.value });
  }
  if (active?.kind === "thinking") {
    content.push({ type: "thinking", thinking: active.value });
  }

  return content;
}

export function createStreamEventValidator(): StreamEventValidator {
  const state: SequenceState = {
    phase: "idle",
    nextContentIndex: 0,
    completedContent: [],
  };

  return {
    accept(event) {
      if (state.phase === "idle") {
        if (event.type !== "start") {
          reject(event, state, 'expected "start" as the first event');
        }
        state.phase = "streaming";
        return;
      }

      if (state.phase === "terminal") {
        reject(event, state, "no events are allowed after a terminal event");
      }
      if (event.type === "start") {
        reject(event, state, '"start" may appear only once');
      }

      switch (event.type) {
        case "text_start":
        case "thinking_start": {
          if (state.activeBlock) {
            reject(event, state, `cannot start a new block while ${state.activeBlock.kind} is active`);
          }
          assertStartIndex(event, state, event.contentIndex);
          state.activeBlock = {
            kind: event.type === "text_start" ? "text" : "thinking",
            contentIndex: event.contentIndex,
            value: "",
          };
          return;
        }

        case "text_delta":
        case "thinking_delta": {
          const expectedKind = event.type === "text_delta" ? "text" : "thinking";
          const active = state.activeBlock;
          if (!active || active.kind === "tool_call" || active.kind !== expectedKind) {
            reject(event, state, `expected active ${expectedKind} block`);
          }
          if (event.contentIndex !== active.contentIndex) {
            reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
          }
          active.value += event.delta;
          return;
        }

        case "text_end":
        case "thinking_end": {
          const expectedKind = event.type === "text_end" ? "text" : "thinking";
          const active = state.activeBlock;
          if (!active || active.kind === "tool_call" || active.kind !== expectedKind) {
            reject(event, state, `expected active ${expectedKind} block`);
          }
          if (event.contentIndex !== active.contentIndex) {
            reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
          }
          if (event.content !== active.value) {
            reject(event, state, "end content does not match accumulated deltas");
          }
          state.completedContent.push(
            expectedKind === "text"
              ? { type: "text", text: active.value }
              : { type: "thinking", thinking: active.value },
          );
          state.activeBlock = undefined;
          state.nextContentIndex += 1;
          return;
        }

        case "tool_call_start": {
          if (state.activeBlock) {
            reject(event, state, `cannot start a new block while ${state.activeBlock.kind} is active`);
          }
          assertStartIndex(event, state, event.contentIndex);
          state.activeBlock = {
            kind: "tool_call",
            contentIndex: event.contentIndex,
            id: event.id,
            name: event.name,
            argumentsJson: "",
            sawArgumentsDelta: false,
          };
          return;
        }

        case "tool_call_delta": {
          const active = state.activeBlock;
          if (!active || active.kind !== "tool_call") {
            reject(event, state, "expected active tool_call block");
          }
          if (event.contentIndex !== active.contentIndex) {
            reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
          }
          active.sawArgumentsDelta = true;
          active.argumentsJson += event.argumentsDelta;
          return;
        }

        case "tool_call_end": {
          const active = state.activeBlock;
          if (!active || active.kind !== "tool_call") {
            reject(event, state, "expected active tool_call block");
          }
          if (event.contentIndex !== active.contentIndex) {
            reject(event, state, `expected contentIndex ${active.contentIndex}, received ${event.contentIndex}`);
          }

          let parsed: JsonObject;
          if (active.sawArgumentsDelta) {
            let candidate: unknown;
            try {
              candidate = JSON.parse(active.argumentsJson);
            } catch {
              reject(event, state, "tool arguments must be valid JSON");
            }
            if (!isJsonObject(candidate)) {
              reject(event, state, "tool arguments must have a JSON object root");
            }
            parsed = candidate;
          } else {
            if (!isJsonObject(event.toolCall.arguments)) {
              reject(event, state, "tool arguments must have a JSON object root");
            }
            parsed = event.toolCall.arguments;
          }

          if (event.toolCall.id !== active.id) {
            reject(event, state, `tool id must remain "${active.id}"`);
          }
          if (event.toolCall.name !== active.name) {
            reject(event, state, `tool name must remain "${active.name}"`);
          }
          if (
            !isJsonObject(event.toolCall.arguments) ||
            (active.sawArgumentsDelta && !jsonDeepEqual(parsed, event.toolCall.arguments))
          ) {
            reject(event, state, "final tool arguments must match accumulated arguments");
          }

          state.completedContent.push({
            type: "tool_call",
            id: active.id,
            name: active.name,
            arguments: parsed,
          });
          state.activeBlock = undefined;
          state.nextContentIndex += 1;
          return;
        }

        case "done": {
          if (state.activeBlock) {
            reject(event, state, "done cannot terminate an active block");
          }
          if (event.reason !== event.message.stopReason) {
            reject(event, state, "event reason must match message.stopReason");
          }
          if (!jsonDeepEqual(event.message.content, state.completedContent)) {
            reject(event, state, "done message content must match completed stream content");
          }
          state.phase = "terminal";
          return;
        }

        case "error": {
          if (event.reason !== event.message.stopReason) {
            reject(event, state, "event reason must match message.stopReason");
          }
          if (!jsonDeepEqual(event.message.content, getExpectedTerminalContent(state))) {
            reject(event, state, "error message content must match safe partial stream content");
          }
          state.phase = "terminal";
          return;
        }
      }
    },
  };
}
