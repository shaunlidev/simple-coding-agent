import { EventStream } from "./event-stream.js";
import type { AssistantMessage, StreamEvent } from "./types.js";
import { createStreamEventValidator } from "./validation.js";

export type AssistantMessageEventStream = EventStream<StreamEvent, AssistantMessage>;

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  const validator = createStreamEventValidator();

  return new EventStream<StreamEvent, AssistantMessage>({
    validate(event) {
      validator.accept(event);
    },
    isTerminal(event) {
      return event.type === "done" || event.type === "error";
    },
    getResult(event) {
      if (event.type === "done" || event.type === "error") {
        return event.message;
      }
      throw new Error("Expected terminal stream event");
    },
  });
}
