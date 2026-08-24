import { EventStream, parseToolArguments, ToolArgumentsValidationError } from "../../ai/src/index.js";
import type {
  AssistantContent,
  AssistantMessage,
  Message,
  Provider,
  ProviderContext,
  StreamEvent,
  ToolCallContent,
  ToolDefinition,
  ToolMessage,
} from "../../ai/src/index.js";

export type AgentEvent =
  | { type: "agent_start"; prompt: string }
  | { type: "turn_start"; turn: number; messages: readonly Message[] }
  | { type: "provider_event"; turn: number; event: StreamEvent }
  | { type: "tool_start"; turn: number; toolCall: ToolCallContent }
  | { type: "tool_end"; turn: number; message: ToolMessage }
  | { type: "agent_end"; messages: readonly Message[] };

export type AgentLoopOptions = {
  provider: Provider;
  model?: Provider["models"][number];
  tools?: readonly ToolDefinition[];
  systemPrompt?: string;
  maxTurns?: number;
  signal?: AbortSignal;
};

export type AgentLoopResult = {
  messages: Message[];
  assistant: AssistantMessage;
};

type AgentLoopEventStream = EventStream<AgentEvent, AgentLoopResult>;

function cloneMessage<T extends Message>(message: T): T {
  return structuredClone(message) as T;
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => cloneMessage(message));
}

function normalizeToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

function createAgentLoopStream(): AgentLoopEventStream {
  return new EventStream<AgentEvent, AgentLoopResult>({
    isTerminal: (event) => event.type === "agent_end",
    getResult: (event) => {
      if (event.type !== "agent_end") {
        throw new Error("Expected terminal agent event");
      }
      const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
      if (!assistant || assistant.role !== "assistant") {
        throw new Error("Agent loop ended without an assistant message");
      }
      return {
        messages: cloneMessages(event.messages),
        assistant: cloneMessage(assistant),
      };
    },
  });
}

export function runAgentLoop(
  prompt: string,
  options: AgentLoopOptions,
  initialMessages: readonly Message[] = [],
): AgentLoopEventStream {
  const stream = createAgentLoopStream();

  queueMicrotask(() => {
    void produceAgentLoop(prompt, options, initialMessages, stream).catch((error) => {
      stream.fail(error);
    });
  });

  return stream;
}

async function produceAgentLoop(
  prompt: string,
  options: AgentLoopOptions,
  initialMessages: readonly Message[],
  stream: AgentLoopEventStream,
): Promise<void> {
  const model = options.model ?? options.provider.models[0];
  if (!model) {
    throw new Error(`Provider "${options.provider.name}" has no models`);
  }

  const maxTurns = options.maxTurns ?? 8;
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const messages: Message[] = [...cloneMessages(initialMessages), { role: "user", content: prompt }];

  stream.push({ type: "agent_start", prompt });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    assertNotAborted(options.signal);
    stream.push({ type: "turn_start", turn, messages: cloneMessages(messages) });

    const context: ProviderContext = {
      systemPrompt: options.systemPrompt,
      messages: cloneMessages(messages),
      tools: options.tools,
    };

    let providerStream;
    try {
      providerStream = options.provider.stream(model, context, { signal: options.signal });
    } catch (error) {
      const message = createAgentErrorMessage(error);
      messages.push(message);
      stream.push({ type: "agent_end", messages: cloneMessages(messages) });
      return;
    }

    for await (const event of providerStream) {
      stream.push({ type: "provider_event", turn, event });
    }

    const assistant = await providerStream.result();
    messages.push(cloneMessage(assistant));

    if (assistant.stopReason === "error") {
      stream.push({ type: "agent_end", messages: cloneMessages(messages) });
      return;
    }

    const toolCalls = assistant.content.filter(
      (block): block is ToolCallContent => block.type === "tool_call",
    );

    if (toolCalls.length === 0) {
      stream.push({ type: "agent_end", messages: cloneMessages(messages) });
      return;
    }

    for (const toolCall of toolCalls) {
      assertNotAborted(options.signal);
      const tool = tools.get(toolCall.name);
      if (!tool) {
        throw new Error(`Unknown tool "${toolCall.name}"`);
      }

      stream.push({ type: "tool_start", turn, toolCall });

      let toolMessage: ToolMessage;
      try {
        const args = parseToolArguments(tool, JSON.stringify(toolCall.arguments));
        const result = await tool.execute?.(args, options.signal);
        toolMessage = {
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: normalizeToolResult(result ?? ""),
        };
      } catch (error) {
        toolMessage = {
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      messages.push(toolMessage);
      stream.push({ type: "tool_end", turn, message: cloneMessage(toolMessage) });
    }
  }

  throw new Error(`Agent loop exceeded maxTurns ${maxTurns}`);
}

function createAgentErrorMessage(error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export type AgentSnapshot = {
  messages: Message[];
  isStreaming: boolean;
};

export type AgentListener = (event: AgentEvent) => void | Promise<void>;

export type AgentOptions = AgentLoopOptions & {
  messages?: readonly Message[];
};

export class Agent {
  readonly #options: AgentLoopOptions;
  readonly #listeners = new Set<AgentListener>();
  #messages: Message[];
  #isStreaming = false;

  constructor(options: AgentOptions) {
    this.#options = options;
    this.#messages = cloneMessages(options.messages ?? []);
  }

  snapshot(): AgentSnapshot {
    return {
      messages: cloneMessages(this.#messages),
      isStreaming: this.#isStreaming,
    };
  }

  subscribe(listener: AgentListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async prompt(prompt: string, options: { signal?: AbortSignal } = {}): Promise<AssistantMessage> {
    if (this.#isStreaming) {
      throw new Error("Agent is already streaming");
    }

    this.#isStreaming = true;
    const loopStream = runAgentLoop(
      prompt,
      { ...this.#options, signal: options.signal ?? this.#options.signal },
      this.#messages,
    );

    try {
      for await (const event of loopStream) {
        await this.#notify(event);
      }

      const result = await loopStream.result();
      this.#messages = cloneMessages(result.messages);
      return cloneMessage(result.assistant);
    } finally {
      this.#isStreaming = false;
    }
  }

  async #notify(event: AgentEvent): Promise<void> {
    for (const listener of this.#listeners) {
      await listener(event);
    }
  }
}

export const agentPackageReady = true;
