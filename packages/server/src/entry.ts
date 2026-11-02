import { createAgentOpsServer } from "./index.js";
import { parseEnvironment } from "@simple-coding-agent/security";

function portFromArgs(): number | undefined {
  const portIndex = process.argv.indexOf("--port");
  if (portIndex >= 0) return Number(process.argv[portIndex + 1]);
  const numeric = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
  return numeric ? Number(numeric) : process.env.PORT ? Number(process.env.PORT) : undefined;
}

const { app, database } = await createAgentOpsServer({ logger: true, startScheduler: true });
const env = parseEnvironment(process.env);
const port = portFromArgs() || env.AGENT_SERVER_PORT;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { try { await app.close(); } finally { if (database.sqlite.open) database.sqlite.close(); } }
  catch { process.stderr.write("Agent Ops shutdown failed\n"); process.exitCode = 1; }
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
try {
  await app.listen({ host: env.AGENT_SERVER_HOST, port });
  process.stdout.write(`Agent Ops API running at http://${env.AGENT_SERVER_HOST}:${port}\n`);
} catch (error) { await shutdown(); throw error; }
