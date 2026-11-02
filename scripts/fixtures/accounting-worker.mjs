import { SQLiteRuntimeStore, RuntimeScheduler, executeContentRun } from "../../packages/runtime/dist/index.js";
import { createDeepSeekProvider } from "../../packages/ai/dist/index.js";

const store = new SQLiteRuntimeStore({ path: process.argv[2] });
const price = { version: process.argv[3] ?? "original", provider: "deepseek", model: "fixture", source: "https://example.test/synthetic", checkedAt: new Date().toISOString(), validFrom: "2000-01-01T00:00:00.000Z", validUntil: "2100-01-01T00:00:00.000Z", inputMicrousdPerMillion: 1_000_000, cachedInputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 2_000_000 };
const worker = new RuntimeScheduler({ runtime: store, runAgent: ({ runId, signal }) => executeContentRun(store, runId, { signal, alreadyStarted: true, prices: [price], providerFactory: () => createDeepSeekProvider({ apiKey: "synthetic", model: "fixture", fetch: async (_url, init) => {
  process.send({ type: "model-dispatched", runId });
  await new Promise((_, reject) => { init.signal.throwIfAborted(); init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); });
  throw new Error("Unreachable fixture response");
} }) }) });
try {
  worker.start();
  if (!store.listContentTasks().length) store.saveContentTask({ id: "accounting", title: "Interrupted provider", instruction: "Collect and summarize the configured source.", model: "fixture", sources: [{ id: "source", kind: "url", url: "https://example.test/article" }], limits: { maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 128 } }, 0);
  process.on("message", async ({ id, command }) => {
    try {
      let result;
      if (command === "run") result = await worker.runTask("accounting", { actor: "fixture", key: "same-request" });
      else if (command === "state") result = { jobs: worker.listJobs(), runs: await store.listRuns(), operations: worker.listJobs().map((job) => ({ runId: job.run_id, observations: store.telemetry.operations(job.run_id) })) };
      else if (command === "stop") { await worker.stop(); store.database.sqlite.close(); result = { stopped: true }; }
      else throw new Error("Unknown fixture command");
      process.send({ id, result }); if (command === "stop") process.disconnect();
    } catch (error) { process.send({ id, error: error instanceof Error ? error.message : "fixture failed" }); }
  });
  process.send({ type: "ready" });
} catch (error) { process.send({ type: "refused", error: error instanceof Error ? error.message : "startup failed" }); store.database.sqlite.close(); process.exitCode = 1; process.disconnect(); }
