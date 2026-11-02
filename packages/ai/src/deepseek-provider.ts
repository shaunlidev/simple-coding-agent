import { createAssistantMessageEventStream } from "./assistant-message-event-stream.js";
import { z } from "zod";
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
  Usage,
} from "./types.js";

export type DeepSeekProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  stream?: boolean;
  thinking?: boolean;
  toolChoice?: "auto" | "required" | "none";
  maxOutputTokens?: number;
  responseFormat?: "text" | "json_object";
  maxResponseBytes?: number;
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

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
  prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
}).superRefine((usage, context) => {
  if (usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) context.addIssue({ code: "custom", message: "usage totals are inconsistent" });
  const nestedHit = usage.prompt_tokens_details?.cached_tokens;
  const hit = usage.prompt_cache_hit_tokens ?? nestedHit;
  const miss = usage.prompt_cache_miss_tokens;
  if (usage.prompt_cache_hit_tokens !== undefined && nestedHit !== undefined && usage.prompt_cache_hit_tokens !== nestedHit) context.addIssue({ code: "custom", message: "cache usage fields disagree" });
  if ((hit !== undefined && hit > usage.prompt_tokens) || (miss !== undefined && miss > usage.prompt_tokens)) context.addIssue({ code: "custom", message: "cache usage exceeds input tokens" });
  if (hit !== undefined && miss !== undefined && hit + miss !== usage.prompt_tokens) context.addIssue({ code: "custom", message: "cache usage breakdown is inconsistent" });
});
const toolCallSchema = z.object({
  id: z.string().min(1), type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});
const responseSchema = z.object({
  model: z.string().optional(), usage: usageSchema.nullish(),
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({ content: z.string().nullish(), reasoning_content: z.string().nullish(), tool_calls: z.array(toolCallSchema).optional() }),
  })).min(1),
});
const chunkSchema = z.object({
  model: z.string().optional(), usage: usageSchema.nullish(),
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    delta: z.object({
      content: z.string().nullish(), reasoning_content: z.string().nullish(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(), id: z.string().optional(), type: z.literal("function").optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
      })).optional(),
    }).optional(),
  })),
});
type DeepSeekChatResponse = z.infer<typeof responseSchema>;
type DeepSeekChunk = z.infer<typeof chunkSchema>;

function toUsage(usage: z.infer<typeof usageSchema> | null | undefined): Usage | undefined {
  if (!usage) return undefined;
  const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  return {
    input: usage.prompt_tokens, output: usage.completion_tokens, totalTokens: usage.total_tokens,
    ...(cacheHit === undefined ? {} : { cacheReadInput: cacheHit }),
    ...(usage.prompt_cache_miss_tokens === undefined ? {} : { cacheMissInput: usage.prompt_cache_miss_tokens }),
  };
}

export class DeepSeekRequestError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  constructor(readonly status: number) {
    super(`DeepSeek request failed with HTTP ${status}`);
    this.name = "DeepSeekRequestError";
    this.retryable = status === 408 || status === 429 || status >= 500;
    this.code = `provider_http_${status}`;
  }
}

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
  return finishReason === "tool_calls" ? "tool_call" : finishReason === "stop" ? "stop" : "error";
}

function parseToolArguments(argsJson: string): JsonObject {
  return z.record(z.string(), z.json()).parse(JSON.parse(argsJson));
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
  model: string,
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

  pushCompletion(stream, { content, finishReason: choice.finish_reason, model: response.model ?? model, usage: toUsage(response.usage) });
}

function pushCompletion(stream: ReturnType<typeof createAssistantMessageEventStream>, options: {
  content: AssistantContent[]; finishReason: string; model: string; usage: Usage | undefined;
}): void {
  const stopReason = mapStopReason(options.finishReason);
  const message: AssistantMessage = {
    role: "assistant", stopReason, content: options.content, provider: "deepseek", model: options.model,
    timestamp: Date.now(), ...(options.usage ? { usage: options.usage } : {}),
    ...(stopReason === "error" ? { errorMessage: `DeepSeek completion failed: ${options.finishReason}`, errorCode: `provider_finish_${options.finishReason}`, retryable: options.finishReason === "insufficient_system_resource" } : {}),
  };
  if (stopReason === "error") stream.push({ type: "error", reason: "error", message });
  else stream.push({ type: "done", reason: stopReason, message });
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
    chunks.push(chunkSchema.parse(JSON.parse(data)));
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

function createStreamingAssembler(stream: ReturnType<typeof createAssistantMessageEventStream>, initialModel: string) {
  const content: AssistantContent[] = [];
  const tools = new Map<number, StreamingToolState>();
  let textIndex: number | undefined;
  let text = "";
  let thinkingIndex: number | undefined;
  let thinking = "";
  let nextContentIndex = 0;
  let finishReason: string | undefined;
  let usage: Usage | undefined;
  let model = initialModel;

  function accept(chunk: DeepSeekChunk): void {
    if (chunk.usage) usage = toUsage(chunk.usage);
    if (chunk.model) model = chunk.model;
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
        text = "";
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
        if (tool.argumentsJson) {
          stream.push({
            type: "tool_call_delta",
            contentIndex: tool.contentIndex,
            argumentsDelta: tool.argumentsJson,
          });
        }
      }
      if (toolDelta.function?.arguments) {
        tool.argumentsJson += toolDelta.function.arguments;
        if (tool.started) {
          stream.push({
            type: "tool_call_delta",
            contentIndex: tool.contentIndex,
            argumentsDelta: toolDelta.function.arguments,
          });
        }
      }
    }
  }

  function finish(sawDone: boolean): void {
    if (thinkingIndex !== undefined) {
      stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking });
      content.push({ type: "thinking", thinking });
    }
    if (textIndex !== undefined) {
      stream.push({ type: "text_end", contentIndex: textIndex, content: text });
      content.push({ type: "text", text });
    }
    const reason = sawDone && finishReason ? finishReason : "incomplete/truncated stream";
    // Partial tool JSON is not executable, but its billed usage still belongs to the failed response.
    if (mapStopReason(reason) === "error") {
      pushCompletion(stream, { content, model, usage, finishReason: reason });
      return;
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

    pushCompletion(stream, { content, model, usage, finishReason: reason });
  }

  return { accept, finish };
}

async function produceFromStreamingResponse(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  response: Response,
  model: string,
  maxResponseBytes: number,
): Promise<void> {
  stream.push({ type: "start" });
  const assembler = createStreamingAssembler(stream, model);
  let buffer = "";
  let sawDone = false;
  function acceptEvent(eventText: string): void {
    if (sawDone && eventText.trim()) throw new Error("DeepSeek stream contains data after DONE");
    sawDone = eventText.split(/\r?\n/).some((line) => line.trim() === "data: [DONE]");
    for (const chunk of parseSseEvent(eventText)) assembler.accept(chunk);
  }

  for await (const text of readBoundedBody(response, maxResponseBytes)) {
    buffer += text;
    let boundary = findSseBoundary(buffer);
    while (boundary) {
      const eventText = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      acceptEvent(eventText);
      boundary = findSseBoundary(buffer);
    }
  }

  if (buffer.trim()) acceptEvent(buffer);
  assembler.finish(sawDone);
}

async function* readBoundedBody(response: Response, maxBytes: number): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`DeepSeek response exceeded byte limit ${maxBytes}`);
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): Provider {
  const maxResponseBytes = z.number().int().min(1).max(8 * 1024 * 1024).parse(options.maxResponseBytes ?? 2 * 1024 * 1024);
  if (options.maxOutputTokens !== undefined) z.number().int().min(1).max(393216).parse(options.maxOutputTokens);
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
      const requestedLimit = streamOptions?.maxOutputTokens;
      if (requestedLimit !== undefined) z.number().int().min(1).max(393216).parse(requestedLimit);
      const maxOutputTokens = options.maxOutputTokens === undefined ? requestedLimit : requestedLimit === undefined ? options.maxOutputTokens : Math.min(options.maxOutputTokens, requestedLimit);
      const stream = createAssistantMessageEventStream();

      queueMicrotask(() => {
        void (async () => {
          const toolChoice = context.messages.some((message) => message.role === "tool") ? undefined : options.toolChoice;
          const body = {
            model: model.id,
            messages: toChatMessages(context),
            tools: toDeepSeekTools(context.tools),
            stream: options.stream === true,
            ...(options.stream === true ? { stream_options: { include_usage: true } } : {}),
            ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
            ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
            ...(options.thinking === true ? {} : { thinking: { type: "disabled" } }),
            ...(toolChoice ? { tool_choice: toolChoice } : {}),
          };
          const apiKey = getApiKey(options);
          streamOptions?.signal?.throwIfAborted();
          const response = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: streamOptions?.signal,
          }).catch((error: unknown) => {
            if (streamOptions?.signal?.aborted) throw error;
            throw Object.assign(new Error("DeepSeek transport request failed"), { code: "provider_transport", retryable: true });
          });

          if (!response.ok) {
            await response.body?.cancel();
            throw new DeepSeekRequestError(response.status);
          }

          if (options.stream === true) {
            await produceFromStreamingResponse(stream, response, model.id, maxResponseBytes);
          } else {
            let text = "";
            for await (const chunk of readBoundedBody(response, maxResponseBytes)) text += chunk;
            produceFromMessage(stream, responseSchema.parse(JSON.parse(text)), model.id);
          }
        })().catch((error) => {
          stream.fail(error);
        });
      });

      return stream;
    },
  };
}
