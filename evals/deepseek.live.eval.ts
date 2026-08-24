import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeekProvider } from "../packages/ai/src/deepseek-provider.ts";

test("live DeepSeek text smoke", async () => {
  if (!process.env.DEEPSEEK_API_KEY) {
    assert.equal(true, true);
    return;
  }

  const provider = createDeepSeekProvider({ model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro" });
  const stream = provider.stream(provider.models[0], {
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  });
  for await (const _ of stream) {
    // drain
  }
  const message = await stream.result();

  assert.equal(message.stopReason, "stop");
  assert.equal(message.content.some((block) => block.type === "text" && block.text.toLowerCase().includes("ok")), true);
});
