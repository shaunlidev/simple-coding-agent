export type EventStreamOptions<TEvent, TResult> = {
  isTerminal: (event: TEvent) => boolean;
  getResult: (event: TEvent) => TResult;
};

type Waiter<TEvent> = {
  resolve: (value: IteratorResult<TEvent>) => void;
  reject: (reason?: unknown) => void;
};

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export class EventStream<TEvent, TResult = TEvent> implements AsyncIterable<TEvent> {
  readonly #isTerminal: (event: TEvent) => boolean;
  readonly #getResult: (event: TEvent) => TResult;
  readonly #queue: TEvent[] = [];
  readonly #waiters: Waiter<TEvent>[] = [];
  readonly #finalResult: Promise<TResult>;
  #resolveFinalResult!: (result: TResult) => void;
  #rejectFinalResult!: (reason?: unknown) => void;
  #terminal = false;
  #failure: Error | undefined;
  #iteratorStarted = false;

  constructor(options: EventStreamOptions<TEvent, TResult>) {
    this.#isTerminal = options.isTerminal;
    this.#getResult = options.getResult;
    this.#finalResult = new Promise<TResult>((resolve, reject) => {
      this.#resolveFinalResult = resolve;
      this.#rejectFinalResult = reject;
    });
  }

  push(event: TEvent): void {
    this.#assertCanPush();

    if (this.#isTerminal(event)) {
      this.#terminal = true;
      this.#resolveFinalResult(this.#getResult(event));
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
      return;
    }

    this.#queue.push(event);
  }

  fail(error: unknown): void {
    if (this.#terminal || this.#failure) return;

    const normalized = normalizeError(error);
    this.#failure = normalized;
    this.#rejectFinalResult(normalized);

    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(normalized);
    }
  }

  result(): Promise<TResult> {
    return this.#finalResult;
  }

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    if (this.#iteratorStarted) {
      throw new Error("EventStream supports only one active iterator");
    }
    this.#iteratorStarted = true;

    return {
      next: () => this.#nextEvent(),
    };
  }

  #nextEvent(): Promise<IteratorResult<TEvent>> {
    if (this.#queue.length > 0) {
      const value = this.#queue.shift() as TEvent;
      return Promise.resolve({ done: false, value });
    }

    if (this.#failure) {
      return Promise.reject(this.#failure);
    }

    if (this.#terminal) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  #assertCanPush(): void {
    if (this.#failure) {
      throw new Error(`Cannot push after stream failed: ${this.#failure.message}`);
    }
    if (this.#terminal) {
      throw new Error("Cannot push after terminal event");
    }
  }
}
