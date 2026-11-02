import { createHash } from "node:crypto";
import { createAgentOpsServer } from "../../packages/server/dist/index.js";

const [path, portText] = process.argv.slice(2);
const port = Number(portText); const origin = `http://127.0.0.1:${port}`;
let paused = false; let server;
try {
  server = await createAgentOpsServer({ startScheduler: true, env: {
    NODE_ENV: "test", AGENT_DB_PATH: path, AGENT_DEMO_MODE: "0",
    AGENT_PUBLIC_ORIGIN: origin, AGENT_CORS_ORIGIN: origin,
    AGENT_SESSION_SECRET: "synthetic-monitoring-session-secret-32-bytes",
    AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret: "synthetic-monitoring-operator-secret-32-bytes" }]),
    AGENT_HEARTBEAT_MS: "100", AGENT_HEARTBEAT_STALE_MS: "4000", AGENT_MONITOR_POLL_MS: "100", AGENT_MONITOR_OVERDUE_MS: "2000",
  }, monitoring: { repeat: (kind, callback, ms) => {
    const timer = setInterval(() => { if (kind !== "heartbeat" || !paused) callback(); }, ms);
    return () => clearInterval(timer);
  } } });
  await server.app.listen({ host: "127.0.0.1", port });
  process.send({ type: "ready", origin });
} catch (error) {
  if (server) { try { await server.app.close(); } finally { server.database.sqlite.close(); } }
  process.send({ type: "refused", error: error instanceof Error ? error.message : "startup failed" });
  process.exitCode = 1; process.disconnect();
}

if (server && process.exitCode !== 1) process.on("message", async ({ id, command }) => {
  try {
    let result;
    if (command === "pause") { paused = true; result = { paused }; }
    else if (command === "resume") { paused = false; result = { paused }; }
    else if (command === "seed") {
      const runId = "monitoring-retention-fixture"; const timestamp = "2026-10-01T00:00:00.000Z";
      for (const event of [server.runtime.createEvent(runId, "run.started", { title: "Retention fixture", trigger: "manual" }),
        server.runtime.createEvent(runId, "agent.output.delta", { turn: 1, delta: "Disposable fixture output" }),
        server.runtime.createEvent(runId, "agent.tool.completed", { callId: "fixture", tool: "fixture", isError: false, result: { evidence: "Protected fixture" } }),
        server.runtime.createEvent(runId, "run.failed", { reason: "controlled_fixture" })]) server.runtime.appendEventSync({ ...event, timestamp });
      result = { runId };
    } else if (command === "state") {
      result = { health: server.monitoring.read(), alerts: server.monitoring.alerts(), samples: server.database.sqlite.prepare("select * from worker_monitor_state order by id").all(),
        deltas: server.database.sqlite.prepare("select id from runtime_events where type='agent.output.delta' order by sequence").all(),
        protectedHash: createHash("sha256").update(JSON.stringify(server.database.sqlite.prepare("select * from runtime_events where type<>'agent.output.delta' order by sequence").all())).digest("hex"),
        prunes: server.database.sqlite.prepare("select * from runtime_prunes").all() };
    } else if (command === "stop") {
      try { await server.app.close(); } finally { server.database.sqlite.close(); }
      process.send({ id, result: { stopped: true } }); process.disconnect(); return;
    } else throw new Error("Unknown fixture command");
    process.send({ id, result });
  } catch (error) { process.send({ id, error: error instanceof Error ? error.message : "fixture failed" }); }
});
