export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type TextContent = {
  type: "text";
  text: string;
};

export type ThinkingContent = {
  type: "thinking";
  thinking: string;
};

export type ToolCallContent = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: JsonObject;
};

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export type AssistantStopReason = "stop" | "tool_call" | "error";

export type AssistantMessage = {
  role: "assistant";
  content: AssistantContent[];
  stopReason: AssistantStopReason;
};

export type StreamEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "tool_call_start"; contentIndex: number; id: string; name: string }
  | { type: "tool_call_delta"; contentIndex: number; argumentsDelta: string }
  | { type: "tool_call_end"; contentIndex: number; toolCall: ToolCallContent }
  | { type: "done"; reason: AssistantStopReason; message: AssistantMessage }
  | { type: "error"; reason: "error"; message: AssistantMessage };
