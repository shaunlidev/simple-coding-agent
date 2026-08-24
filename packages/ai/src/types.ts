import type { AssistantMessageEventStream } from "./assistant-message-event-stream.js";

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

export type Usage = {
  input: number;
  output: number;
  totalTokens: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: AssistantContent[];
  stopReason: AssistantStopReason;
  provider?: string;
  model?: string;
  timestamp?: number;
  usage?: Usage;
  errorMessage?: string;
};

export type UserMessage = {
  role: "user";
  content: string;
};

export type Message = UserMessage | AssistantMessage;

export type ToolParameterSchema =
  | {
      type: "object";
      properties: Record<string, ToolParameterSchema>;
      required?: readonly string[];
      additionalProperties?: boolean;
    }
  | { type: "string"; minLength?: number }
  | { type: "number"; minimum?: number }
  | { type: "boolean" }
  | { type: "array"; items: ToolParameterSchema; minItems?: number };

export type ToolDefinition<TArguments extends JsonObject = JsonObject> = {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  execute?: (args: TArguments) => Promise<unknown> | unknown;
};

export type Model = {
  id: string;
  name: string;
  provider: string;
};

export type ProviderContext = {
  systemPrompt?: string;
  messages: Message[];
  tools?: readonly ToolDefinition[];
};

export type StreamOptions = {
  signal?: AbortSignal;
};

export type Provider = {
  readonly id: string;
  readonly name: string;
  readonly models: readonly Model[];
  stream(model: Model, context: ProviderContext, options?: StreamOptions): AssistantMessageEventStream;
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
