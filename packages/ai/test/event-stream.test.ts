import assert from "node:assert/strict";
import test from "node:test";
import { EventStream } from "../src/event-stream.ts";

type TestEvent =
  | { type: "delta"; value: string }
  | { type: "done"; value: string };

function createStream(): EventStream<TestEvent, string> {
  return new EventStream<TestEvent, string>({
    isTerminal: (event) => event.type === "done",
    getResult: (event) => event.value,
  });
}

test("yields pushed events in order when producer is ahead", async () => {
  const stream = createStream();
  stream.push({ type: "delta", value: "a" });
  stream.push({ type: "delta", value: "b" });
  stream.push({ type: "done", value: "ab" });

  const events: TestEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.deepEqual(events.map((event) => event.value), ["a", "b", "ab"]);
  assert.equal(await stream.result(), "ab");
});

test("resolves a waiting consumer when producer pushes later", async () => {
  const stream = createStream();
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();

  stream.push({ type: "delta", value: "later" });

  assert.deepEqual(await pending, {
    done: false,
    value: { type: "delta", value: "later" },
  });
});

test("finishes iteration after terminal event has been consumed", async () => {
  const stream = createStream();
  const iterator = stream[Symbol.asyncIterator]();

  stream.push({ type: "done", value: "final" });

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "done", value: "final" },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(await stream.result(), "final");
});

test("rejects pending waiters and result when stream fails", async () => {
  const stream = createStream();
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();

  stream.fail("boom");

  await assert.rejects(pending, /boom/);
  await assert.rejects(stream.result(), /boom/);
});

test("does not allow pushing after terminal event", () => {
  const stream = createStream();
  stream.push({ type: "done", value: "final" });

  assert.throws(() => {
    stream.push({ type: "delta", value: "too late" });
  }, /Cannot push after terminal event/);
});

test("does not allow pushing after failure", () => {
  const stream = createStream();
  stream.fail(new Error("network down"));
  void stream.result().catch(() => undefined);

  assert.throws(() => {
    stream.push({ type: "delta", value: "too late" });
  }, /Cannot push after stream failed: network down/);
});

test("allows only one active iterator", () => {
  const stream = createStream();
  stream[Symbol.asyncIterator]();

  assert.throws(() => {
    stream[Symbol.asyncIterator]();
  }, /only one active iterator/);
});
