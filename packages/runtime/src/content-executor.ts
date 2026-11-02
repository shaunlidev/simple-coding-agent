import { createDeepSeekProvider } from "@simple-coding-agent/ai";
import type { AgentEnvironment } from "@simple-coding-agent/security";
import { runDemoAgent, type SQLiteRuntimeStore } from "./index.js";
import { executeContentRun, type ContentProviderFactory } from "./content-agent.js";
import { createDemoContentProvider } from "./demo-content.js";

export function createContentExecutor(store: SQLiteRuntimeStore, options: {
  env: AgentEnvironment; providerFactory?: ContentProviderFactory;
  browser?: Parameters<typeof executeContentRun>[2]["browser"];
}) {
  return async ({ runId, signal }: { runId: string; signal: AbortSignal }) => {
    const task = store.readRunTask(runId)?.definition;
    if (!task) {
      if (options.env.AGENT_DEMO_MODE !== "1" || options.env.NODE_ENV === "production") throw new Error("A configured content task is required");
      return runDemoAgent(store, { runId, trigger: (await store.projectRun(runId)).trigger, delayMs: 0, alreadyStarted: true, signal, emitSchedulerEvent: false });
    }
    if (task.mode === "demo" && options.env.NODE_ENV === "production") throw new Error("Demo content tasks are disabled in production");
    const providerFactory: ContentProviderFactory = task.mode === "demo" ? createDemoContentProvider : options.providerFactory ?? ((definition) => {
      if (!options.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for real content runs");
      return createDeepSeekProvider({ apiKey: options.env.DEEPSEEK_API_KEY, model: definition.model, stream: true, maxOutputTokens: definition.limits.maxOutputTokens, responseFormat: "json_object", toolChoice: "required" });
    });
    return executeContentRun(store, runId, { providerFactory, signal, alreadyStarted: true, browser: options.browser });
  };
}
