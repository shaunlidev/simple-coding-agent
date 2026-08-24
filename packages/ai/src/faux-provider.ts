import { EventStream } from "./event-stream.js";
import type {
  AssistantContent,
  AssistantMessage,
  Model,
  Provider,
  ProviderContext,
  StreamOptions,
  StreamEvent,
  ToolCallContent,
} from "./types.js";
import { createStreamEventValidator } from "./validation.js";

type AssistantMessageEventStream = EventStream<StreamEvent, AssistantMessage>;

export type FauxResponse =
  | string
  | {
      type: "success";
      content: AssistantContent[];
      stopReason?: "stop" | "tool_call";
    }
  | {
      type: "failure";
      errorMessage: string;
    };

export type FauxProviderOptions = {
  responses: readonly FauxResponse[];
  chunkSize?: number;
  chunkDelayMs?: number;
  now?: () => number;
};

export type FauxProviderHandle = {
  readonly provider: Provider;
  readonly model: Model;
  pendingResponses(): number;
};

type NormalizedResponse =
  | {
      type: "success";
      content: AssistantContent[];
      stopReason: "stop" | "tool_call";
    }
  | {
      type: "failure";
      errorMessage: string;
    };

const FAUX_MODEL: Model = {
  id: "faux-model",
  name: "Faux Model",
  provider: "faux",
};

function createValidatedStream(): AssistantMessageEventStream {
  const validator = createStreamEventValidator();

  return new EventStream<StreamEvent, AssistantMessage>({
    validate: (event) => validator.accept(event),
    isTerminal: (event) => event.type === "done" || event.type === "error",
    getResult: (event) => {
      if (event.type === "done" || event.type === "error") return event.message;
      throw new Error("Expected terminal stream event");
    },
  });
}

function normalizeResponse(response: FauxResponse): NormalizedResponse {
  if (typeof response === "string") {
    return {
      type: "success",
      content: [{ type: "text", text: response }],
      stopReason: "stop",
    };
  }

  if (response.type === "failure") {
    return { ...response };
  }

  const hasToolCall = response.content.some((block) => block.type === "tool_call");
  if (hasToolCall && response.stopReason !== undefined && response.stopReason !== "tool_call") {
    throw new Error("tool_call content requires stopReason tool_call");
  }
  if (!hasToolCall && response.stopReason === "tool_call") {
    throw new Error("stopReason tool_call requires tool_call content");
  }

  return {
    type: "success",
    content: [...response.content],
    stopReason: response.stopReason ?? (hasToolCall ? "tool_call" : "stop"),
  };
}

function splitIntoChunks(value: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    chunks.push(value.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    totalTokens: 0,
  };
}

function createAssistantMessage(
  model: Model,
  content: AssistantContent[],
  stopReason: AssistantMessage["stopReason"],
  timestamp: number,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [...content],
    stopReason,
    provider: model.provider,
    model: model.id,
    timestamp,
    usage: createZeroUsage(),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function createAbortedMessage(model: Model, content: AssistantContent[], timestamp: number): AssistantMessage {
  return createAssistantMessage(model, content, "error", timestamp, "Aborted");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function pushAbort(
  stream: AssistantMessageEventStream,
  model: Model,
  partialContent: AssistantContent[],
  timestamp: number,
): boolean {
  stream.push({
    type: "error",
    reason: "error",
    message: createAbortedMessage(model, partialContent, timestamp),
  });
  return true;
}

async function streamTextBlock(
  stream: AssistantMessageEventStream,
  block: Extract<AssistantContent, { type: "text" }>,
  contentIndex: number,
  chunkSize: number,
  chunkDelayMs: number,
  partialContent: AssistantContent[],
  model: Model,
  timestamp: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  stream.push({ type: "text_start", contentIndex });
  let emitted = "";

  for (const chunk of splitIntoChunks(block.text, chunkSize)) {
    if (isAborted(signal)) {
      return pushAbort(stream, model, [...partialContent, { type: "text", text: emitted }], timestamp);
    }
    stream.push({ type: "text_delta", contentIndex, delta: chunk });
    emitted += chunk;
    await delay(chunkDelayMs);
  }

  if (isAborted(signal)) {
    return pushAbort(stream, model, [...partialContent, { type: "text", text: emitted }], timestamp);
  }
  stream.push({ type: "text_end", contentIndex, content: block.text });
  partialContent.push(block);
  return false;
}

async function streamThinkingBlock(
  stream: AssistantMessageEventStream,
  block: Extract<AssistantContent, { type: "thinking" }>,
  contentIndex: number,
  chunkSize: number,
  chunkDelayMs: number,
  partialContent: AssistantContent[],
  model: Model,
  timestamp: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  stream.push({ type: "thinking_start", contentIndex });
  let emitted = "";

  for (const chunk of splitIntoChunks(block.thinking, chunkSize)) {
    if (isAborted(signal)) {
      return pushAbort(stream, model, [...partialContent, { type: "thinking", thinking: emitted }], timestamp);
    }
    stream.push({ type: "thinking_delta", contentIndex, delta: chunk });
    emitted += chunk;
    await delay(chunkDelayMs);
  }

  if (isAborted(signal)) {
    return pushAbort(stream, model, [...partialContent, { type: "thinking", thinking: emitted }], timestamp);
  }
  stream.push({ type: "thinking_end", contentIndex, content: block.thinking });
  partialContent.push(block);
  return false;
}

async function streamToolCallBlock(
  stream: AssistantMessageEventStream,
  block: ToolCallContent,
  contentIndex: number,
  chunkSize: number,
  chunkDelayMs: number,
  partialContent: AssistantContent[],
  model: Model,
  timestamp: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  stream.push({ type: "tool_call_start", contentIndex, id: block.id, name: block.name });

  for (const chunk of splitIntoChunks(JSON.stringify(block.arguments), chunkSize)) {
    if (isAborted(signal)) {
      return pushAbort(stream, model, partialContent, timestamp);
    }
    stream.push({ type: "tool_call_delta", contentIndex, argumentsDelta: chunk });
    await delay(chunkDelayMs);
  }

  if (isAborted(signal)) {
    return pushAbort(stream, model, partialContent, timestamp);
  }
  stream.push({ type: "tool_call_end", contentIndex, toolCall: block });
  partialContent.push(block);
  return false;
}

async function produceResponse(
  stream: AssistantMessageEventStream,
  response: NormalizedResponse,
  chunkSize: number,
  chunkDelayMs: number,
  model: Model,
  timestamp: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  stream.push({ type: "start" });

  if (isAborted(signal)) {
    pushAbort(stream, model, [], timestamp);
    return;
  }

  if (response.type === "failure") {
    stream.push({
      type: "error",
      reason: "error",
      message: createAssistantMessage(model, [], "error", timestamp, response.errorMessage),
    });
    return;
  }

  const partialContent: AssistantContent[] = [];

  for (const [contentIndex, block] of response.content.entries()) {
    const aborted =
      block.type === "text"
        ? await streamTextBlock(stream, block, contentIndex, chunkSize, chunkDelayMs, partialContent, model, timestamp, signal)
        : block.type === "thinking"
          ? await streamThinkingBlock(
              stream,
              block,
              contentIndex,
              chunkSize,
              chunkDelayMs,
              partialContent,
              model,
              timestamp,
              signal,
            )
          : await streamToolCallBlock(
              stream,
              block,
              contentIndex,
              chunkSize,
              chunkDelayMs,
              partialContent,
              model,
              timestamp,
              signal,
            );

    if (aborted) return;
  }

  stream.push({
    type: "done",
    reason: response.stopReason,
    message: createAssistantMessage(model, response.content, response.stopReason, timestamp),
  });
}

export function createFauxProvider(options: FauxProviderOptions): FauxProviderHandle {
  const queue = options.responses.map(normalizeResponse);
  const chunkSize = options.chunkSize ?? 4;
  const chunkDelayMs = options.chunkDelayMs ?? 0;
  const now = options.now ?? Date.now;

  if (chunkSize < 1 || !Number.isInteger(chunkSize)) {
    throw new Error("chunkSize must be a positive integer");
  }

  const provider: Provider = {
    id: "faux",
    name: "Faux Provider",
    models: [FAUX_MODEL],
    stream(_model: Model, _context: ProviderContext, streamOptions?: StreamOptions) {
      const stream = createValidatedStream();
      const response = queue.shift();

      queueMicrotask(() => {
        void produceResponse(
          stream,
          response ?? {
            type: "failure",
            errorMessage: "Faux provider response queue is exhausted",
          },
          chunkSize,
          chunkDelayMs,
          FAUX_MODEL,
          now(),
          streamOptions?.signal,
        ).catch((error) => {
          stream.fail(error);
        });
      });

      return stream;
    },
  };

  return {
    provider,
    model: FAUX_MODEL,
    pendingResponses() {
      return queue.length;
    },
  };
}
