import { EventStream, parseToolArguments, ToolArgumentsValidationError } from "@simple-coding-agent/ai";
import type {
  AssistantContent,
  AssistantMessage,
  Message,
  Provider,
  ProviderContext,
  StreamEvent,
  StreamOptions,
  ToolCallContent,
  ToolDefinition,
  ToolMessage,
} from "@simple-coding-agent/ai";

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
  maxToolCalls?: number;
  signal?: AbortSignal;
  dispatch?: AgentDispatch;
};

export type AgentDispatch = {
  model(call: { turn: number; model: Provider["models"][number]; context: ProviderContext }, invoke: (options?: StreamOptions) => Promise<AssistantMessage>): Promise<AssistantMessage>;
  tool(call: { turn: number; toolCall: ToolCallContent }, invoke: (signal?: AbortSignal) => Promise<ToolMessage>): Promise<ToolMessage>;
};

function combineSignals(original?: AbortSignal, governed?: AbortSignal) {
  return original && governed ? AbortSignal.any([original, governed]) : original ?? governed;
}

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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Operation aborted");
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
  const maxToolCalls = options.maxToolCalls ?? 32;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new Error("Agent turn/tool limits must be nonnegative integers with at least one turn");
  }
  let toolCallsUsed = 0;
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const messages: Message[] = [...cloneMessages(initialMessages), { role: "user", content: prompt }];

  stream.push({ type: "agent_start", prompt });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (options.signal?.aborted) {
      messages.push(createAgentErrorMessage(new Error("Operation aborted"), "aborted"));
      stream.push({ type: "agent_end", messages: cloneMessages(messages) });
      return;
    }
    stream.push({ type: "turn_start", turn, messages: cloneMessages(messages) });

    const context: ProviderContext = {
      systemPrompt: options.systemPrompt,
      messages: cloneMessages(messages),
      tools: options.tools,
    };

    let invoked = false;
    const invokeModel = async (permit: StreamOptions = {}) => {
      if (invoked) throw new Error("Model callback already invoked");
      invoked = true;
      const signal = combineSignals(options.signal, permit.signal);
      assertNotAborted(signal);
      const providerStream = options.provider.stream(model, context, { ...permit, signal });
      const result = providerStream.result();
      void result.catch(() => undefined);
      try {
        for await (const event of providerStream) stream.push({ type: "provider_event", turn, event });
        return await result;
      } catch (error) { await result.catch(() => undefined); throw error; }
    };
    let assistant: AssistantMessage;
    try {
      assistant = options.dispatch ? await options.dispatch.model({ turn, model, context }, invokeModel) : await invokeModel();
    } catch (error) {
      const message = createAgentErrorMessage(error, options.signal?.aborted || isAbortError(error) ? "aborted" : "error");
      messages.push(message);
      stream.push({ type: "agent_end", messages: cloneMessages(messages) });
      return;
    }

    messages.push(cloneMessage(assistant));

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
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
      if (options.signal?.aborted) {
        messages.push(createAgentErrorMessage(new Error("Operation aborted"), "aborted"));
        stream.push({ type: "agent_end", messages: cloneMessages(messages) });
        return;
      }
      if (toolCallsUsed >= maxToolCalls) throw new Error(`Agent loop exceeded maxToolCalls ${maxToolCalls}`);
      toolCallsUsed++;
      const tool = tools.get(toolCall.name);
      if (!tool) {
        throw new Error(`Unknown tool "${toolCall.name}"`);
      }

      stream.push({ type: "tool_start", turn, toolCall });

      let toolInvoked = false;
      const invokeTool = async (governed?: AbortSignal): Promise<ToolMessage> => {
        if (toolInvoked) throw new Error("Tool callback already invoked");
        toolInvoked = true;
        const signal = combineSignals(options.signal, governed);
        assertNotAborted(signal);
        try {
          const args = parseToolArguments(tool, JSON.stringify(toolCall.arguments));
          const result = await tool.execute?.(args, signal);
          return { role: "tool", toolCallId: toolCall.id, toolName: toolCall.name, content: normalizeToolResult(result ?? "") };
        } catch (error) {
          return { role: "tool", toolCallId: toolCall.id, toolName: toolCall.name, content: error instanceof Error ? error.message : String(error), isError: true };
        }
      };
      const toolMessage = options.dispatch ? await options.dispatch.tool({ turn, toolCall }, invokeTool) : await invokeTool();

      messages.push(toolMessage);
      stream.push({ type: "tool_end", turn, message: cloneMessage(toolMessage) });
    }
  }

  throw new Error(`Agent loop exceeded maxTurns ${maxTurns}`);
}

function createAgentErrorMessage(error: unknown, stopReason: "error" | "aborted" = "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    stopReason,
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { errorCode: error.code } : {}),
    ...(error instanceof Error && "retryable" in error && typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
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
    const lifecycle = new AbortController();
    const upstream = options.signal ?? this.#options.signal;
    const loopStream = runAgentLoop(
      prompt,
      { ...this.#options, signal: upstream ? AbortSignal.any([upstream, lifecycle.signal]) : lifecycle.signal },
      this.#messages,
    );
    // A listener can fail before the producer ends. Observe its result immediately and abort/drain on failure.
    const completion = loopStream.result();
    void completion.catch(() => undefined);

    try {
      for await (const event of loopStream) {
        await this.#notify(event);
      }

      const result = await completion;
      this.#messages = cloneMessages(result.messages);
      return cloneMessage(result.assistant);
    } catch (error) {
      lifecycle.abort(error);
      await completion.catch(() => undefined);
      throw error;
    } finally {
      lifecycle.abort();
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
