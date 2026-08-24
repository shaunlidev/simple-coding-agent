import { createAssistantMessageEventStream } from "./assistant-message-event-stream.js";
import type {
  AssistantContent,
  AssistantMessage,
  JsonObject,
  Model,
  Provider,
  ProviderContext,
  StreamEvent,
  StreamOptions,
  ToolCallContent,
  ToolDefinition,
} from "./types.js";

export type DeepSeekProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  stream?: boolean;
  thinking?: boolean;
  toolChoice?: "auto" | "required" | "none";
  fetch?: typeof fetch;
};

const DEEPSEEK_MODEL: Model = {
  id: "deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  provider: "deepseek",
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: DeepSeekToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type DeepSeekChatResponse = {
  choices: Array<{
    finish_reason: string;
    message: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    };
  }>;
};

type DeepSeekChunk = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
};

function getApiKey(options: DeepSeekProviderOptions): string {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to use DeepSeekProvider");
  }
  return apiKey;
}

function toChatMessages(context: ProviderContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
    } else if (message.role === "tool") {
      messages.push({ role: "tool", content: message.content, tool_call_id: message.toolCallId });
    } else {
      const toolCalls = message.content
        .filter((block): block is ToolCallContent => block.type === "tool_call")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          },
        }));
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      });
    }
  }

  return messages;
}

function toDeepSeekTools(tools: readonly ToolDefinition[] | undefined) {
  return tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function mapStopReason(finishReason: string): AssistantMessage["stopReason"] {
  return finishReason === "tool_calls" ? "tool_call" : "stop";
}

function parseToolArguments(argsJson: string): JsonObject {
  const parsed = JSON.parse(argsJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DeepSeek tool arguments must have a JSON object root");
  }
  return parsed as JsonObject;
}

function pushText(stream: ReturnType<typeof createAssistantMessageEventStream>, contentIndex: number, text: string): void {
  stream.push({ type: "text_start", contentIndex });
  if (text) stream.push({ type: "text_delta", contentIndex, delta: text });
  stream.push({ type: "text_end", contentIndex, content: text });
}

function pushThinking(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  contentIndex: number,
  thinking: string,
): void {
  stream.push({ type: "thinking_start", contentIndex });
  if (thinking) stream.push({ type: "thinking_delta", contentIndex, delta: thinking });
  stream.push({ type: "thinking_end", contentIndex, content: thinking });
}

function pushToolCall(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  contentIndex: number,
  toolCall: DeepSeekToolCall,
): void {
  const args = parseToolArguments(toolCall.function.arguments || "{}");
  const block: ToolCallContent = {
    type: "tool_call",
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: args,
  };
  stream.push({ type: "tool_call_start", contentIndex, id: block.id, name: block.name });
  if (toolCall.function.arguments) {
    stream.push({ type: "tool_call_delta", contentIndex, argumentsDelta: toolCall.function.arguments });
  }
  stream.push({ type: "tool_call_end", contentIndex, toolCall: block });
}

function produceFromMessage(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  response: DeepSeekChatResponse,
): void {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error("DeepSeek response did not include a choice");
  }

  stream.push({ type: "start" });
  const content: AssistantContent[] = [];
  let contentIndex = 0;

  if (choice.message.reasoning_content) {
    pushThinking(stream, contentIndex, choice.message.reasoning_content);
    content.push({ type: "thinking", thinking: choice.message.reasoning_content });
    contentIndex += 1;
  }
  if (choice.message.content) {
    pushText(stream, contentIndex, choice.message.content);
    content.push({ type: "text", text: choice.message.content });
    contentIndex += 1;
  }
  for (const toolCall of choice.message.tool_calls ?? []) {
    pushToolCall(stream, contentIndex, toolCall);
    content.push({
      type: "tool_call",
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: parseToolArguments(toolCall.function.arguments || "{}"),
    });
    contentIndex += 1;
  }

  const stopReason = mapStopReason(choice.finish_reason);
  stream.push({
    type: "done",
    reason: stopReason,
    message: { role: "assistant", stopReason, content },
  });
}

type StreamingToolState = {
  contentIndex: number;
  id: string;
  name: string;
  argumentsJson: string;
  started: boolean;
};

function parseSseEvent(text: string): DeepSeekChunk[] {
  const chunks: DeepSeekChunk[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    chunks.push(JSON.parse(data));
  }
  return chunks;
}

function findSseBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function createStreamingAssembler(stream: ReturnType<typeof createAssistantMessageEventStream>) {
  const content: AssistantContent[] = [];
  const tools = new Map<number, StreamingToolState>();
  let textIndex: number | undefined;
  let text = "";
  let thinkingIndex: number | undefined;
  let thinking = "";
  let nextContentIndex = 0;
  let finishReason = "stop";

  function accept(chunk: DeepSeekChunk): void {
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (choice.finish_reason) finishReason = choice.finish_reason;

    if (delta.reasoning_content) {
      if (thinkingIndex === undefined) {
        thinkingIndex = nextContentIndex;
        nextContentIndex += 1;
        stream.push({ type: "thinking_start", contentIndex: thinkingIndex });
      }
      thinking += delta.reasoning_content;
      stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: delta.reasoning_content });
    }
    if (delta.content) {
      if (thinkingIndex !== undefined) {
        stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking });
        content.push({ type: "thinking", thinking });
        thinkingIndex = undefined;
      }
      if (textIndex === undefined) {
        textIndex = nextContentIndex;
        nextContentIndex += 1;
        stream.push({ type: "text_start", contentIndex: textIndex });
      }
      text += delta.content;
      stream.push({ type: "text_delta", contentIndex: textIndex, delta: delta.content });
    }
    for (const toolDelta of delta.tool_calls ?? []) {
      if (thinkingIndex !== undefined) {
        stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking });
        content.push({ type: "thinking", thinking });
        thinkingIndex = undefined;
      }
      if (textIndex !== undefined) {
        stream.push({ type: "text_end", contentIndex: textIndex, content: text });
        content.push({ type: "text", text });
        textIndex = undefined;
      }
      let tool = tools.get(toolDelta.index);
      if (!tool) {
        tool = {
          contentIndex: nextContentIndex,
          id: toolDelta.id ?? `tool-${toolDelta.index}`,
          name: toolDelta.function?.name ?? "",
          argumentsJson: "",
          started: false,
        };
        tools.set(toolDelta.index, tool);
        nextContentIndex += 1;
      }
      if (toolDelta.id) tool.id = toolDelta.id;
      if (toolDelta.function?.name) tool.name = toolDelta.function.name;
      if (!tool.started && tool.name) {
        stream.push({ type: "tool_call_start", contentIndex: tool.contentIndex, id: tool.id, name: tool.name });
        tool.started = true;
      }
      if (toolDelta.function?.arguments) {
        tool.argumentsJson += toolDelta.function.arguments;
        stream.push({
          type: "tool_call_delta",
          contentIndex: tool.contentIndex,
          argumentsDelta: toolDelta.function.arguments,
        });
      }
    }
  }

  function finish(): void {
    if (thinkingIndex !== undefined) {
      stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking });
      content.push({ type: "thinking", thinking });
    }
    if (textIndex !== undefined) {
      stream.push({ type: "text_end", contentIndex: textIndex, content: text });
      content.push({ type: "text", text });
    }
    for (const tool of [...tools.values()].sort((left, right) => left.contentIndex - right.contentIndex)) {
      const block: ToolCallContent = {
        type: "tool_call",
        id: tool.id,
        name: tool.name,
        arguments: parseToolArguments(tool.argumentsJson || "{}"),
      };
      stream.push({ type: "tool_call_end", contentIndex: tool.contentIndex, toolCall: block });
      content.push(block);
    }

    const stopReason = mapStopReason(finishReason);
    stream.push({ type: "done", reason: stopReason, message: { role: "assistant", stopReason, content } });
  }

  return { accept, finish };
}

async function produceFromStreamingResponse(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  response: Response,
): Promise<void> {
  stream.push({ type: "start" });
  const assembler = createStreamingAssembler(stream);
  const body = response.body;
  if (!body) {
    assembler.finish();
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = findSseBoundary(buffer);
    while (boundary) {
      const eventText = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      for (const chunk of parseSseEvent(eventText)) {
        assembler.accept(chunk);
      }
      boundary = findSseBoundary(buffer);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const chunk of parseSseEvent(buffer)) {
      assembler.accept(chunk);
    }
  }
  assembler.finish();
}

export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): Provider {
  const model: Model = {
    ...DEEPSEEK_MODEL,
    id: options.model ?? DEEPSEEK_MODEL.id,
  };
  const baseUrl = options.baseUrl ?? "https://api.deepseek.com";
  const doFetch = options.fetch ?? fetch;

  return {
    id: "deepseek",
    name: "DeepSeek",
    models: [model],
    stream(_model: Model, context: ProviderContext, streamOptions?: StreamOptions) {
      const stream = createAssistantMessageEventStream();

      queueMicrotask(() => {
        void (async () => {
          const toolChoice = context.messages.some((message) => message.role === "tool") ? undefined : options.toolChoice;
          const body = {
            model: model.id,
            messages: toChatMessages(context),
            tools: toDeepSeekTools(context.tools),
            stream: options.stream === true,
            ...(options.thinking === true ? {} : { thinking: { type: "disabled" } }),
            ...(toolChoice ? { tool_choice: toolChoice } : {}),
          };
          const response = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${getApiKey(options)}`,
            },
            body: JSON.stringify(body),
            signal: streamOptions?.signal,
          });

          if (!response.ok) {
            throw new Error(`DeepSeek request failed with HTTP ${response.status}: ${await response.text()}`);
          }

          if (options.stream === true) {
            await produceFromStreamingResponse(stream, response);
          } else {
            produceFromMessage(stream, (await response.json()) as DeepSeekChatResponse);
          }
        })().catch((error) => {
          stream.fail(error);
        });
      });

      return stream;
    },
  };
}
