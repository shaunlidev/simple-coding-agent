import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../packages/agent/src/index.ts";
import { createDeepSeekProvider } from "../packages/ai/dist/deepseek-provider.js";
import { createLocalTools } from "../packages/coding-agent/src/tools.ts";

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

test("live DeepSeek tool-call smoke", async () => {
  if (!process.env.DEEPSEEK_API_KEY) {
    assert.equal(true, true);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "deepseek-live-tools-"));
  await writeFile(join(root, "fixture.txt"), "acceptance-token-7291");

  const provider = createDeepSeekProvider({
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    toolChoice: "required",
  });
  const agent = new Agent({
    provider,
    model: provider.models[0],
    tools: createLocalTools({ allowedRoot: root }).filter((tool) => tool.name === "read"),
    maxTurns: 4,
  });
  const toolEvents: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "tool_start") toolEvents.push(event.toolCall.name);
  });

  const message = await agent.prompt(
    "Use the read tool to read fixture.txt, then reply with the exact token found in the file.",
  );

  assert.equal(toolEvents.includes("read"), true);
  assert.equal(message.stopReason, "stop");
  assert.equal(
    message.content.some((block) => block.type === "text" && block.text.includes("acceptance-token-7291")),
    true,
  );
});
