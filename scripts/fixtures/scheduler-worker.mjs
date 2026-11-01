import { SQLiteRuntimeStore, RuntimeScheduler, executeContentRun } from "../../packages/runtime/dist/index.js";
import { SafeNetwork } from "../../packages/security/dist/index.js";
import { createDeepSeekProvider } from "../../packages/ai/dist/index.js";

const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async ({ url }) => ({ url: url.href, status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("Durable queue acceptance source content.") }) });
const store = new SQLiteRuntimeStore({ path: process.argv[2], network });
const providerFactory = () => createDeepSeekProvider({ apiKey: "synthetic", fetch: async (_url, init) => {
  const request = JSON.parse(init.body); const result = request.messages.find((message) => message.role === "tool");
  const outcome = result ? JSON.parse(result.content) : undefined;
  const doc = outcome?.status === "ok" ? outcome.documents[0] : undefined;
  if (outcome && !doc) return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"items":[]}' } }] });
  return Response.json({ choices: [{ finish_reason: doc ? "stop" : "tool_calls", message: doc ? { content: JSON.stringify({ items: [{ documentId: doc.id, summary: doc.text, reason: "Requested queue acceptance evidence.", score: 80, quotes: [doc.text] }] }) } : { tool_calls: [{ id: "collect", type: "function", function: { name: "collect_source", arguments: '{"sourceId":"source"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
} });
const releases = new Map();
const worker = new RuntimeScheduler({ runtime: store, runAgent: async ({ runId, signal }) => {
  process.send?.({ type: "started", runId });
  await new Promise((resolve, reject) => {
    releases.set(runId, resolve);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return executeContentRun(store, runId, { providerFactory, signal, alreadyStarted: true });
} });
try {
  worker.start();
  if (!store.listContentTasks().length) {
    store.saveContentTask({ id: "task", title: "Frozen queue task", instruction: "Summarize the actual source", model: "fixture", sources: [{ id: "source", kind: "url", url: "https://source.test/page" }] }, 0);
    await store.createSchedule({ id: "schedule", taskId: "task", title: "Queue acceptance", cron: "@every 1h", timezone: "UTC", enabled: false, nextRunAt: new Date(Date.now() + 3_600_000).toISOString(), overlapPolicy: "queue" });
  }
  process.on("message", async (message) => {
    try {
      let result;
      if (message.command === "run") result = await worker.runNow("schedule", { actor: "test", key: message.key });
      else if (message.command === "release") { releases.get(message.runId)?.(); result = true; }
      else if (message.command === "state") result = { jobs: worker.listJobs(), runs: await store.listRuns(), schedules: store.readSchedulesSync(), tasks: worker.listJobs().map((job) => store.readRunTask(job.run_id)), failures: (await store.listEvents()).filter((event) => event.type === "run.failed") };
      else if (message.command === "stop") { await worker.stop(); store.database.sqlite.close(); result = true; }
      else throw new Error("Unknown fixture command");
      process.send?.({ id: message.id, result });
      if (message.command === "stop") process.disconnect();
    } catch (error) { process.send?.({ id: message.id, error: error.message }); }
  });
  process.send?.({ type: "ready" });
} catch (error) {
  process.send?.({ type: "refused", error: error.message });
  store.database.sqlite.close(); process.exitCode = 1; process.disconnect();
}
