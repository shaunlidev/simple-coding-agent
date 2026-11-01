import { createAgentOpsServer } from "./index.js";
import { parseEnvironment } from "@simple-coding-agent/security";

function portFromArgs(): number | undefined {
  const portIndex = process.argv.indexOf("--port");
  if (portIndex >= 0) return Number(process.argv[portIndex + 1]);
  const numeric = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
  return numeric ? Number(numeric) : process.env.PORT ? Number(process.env.PORT) : undefined;
}

const { app } = await createAgentOpsServer({ logger: true, startScheduler: true });
const env = parseEnvironment(process.env);
const port = portFromArgs() || env.AGENT_SERVER_PORT;
await app.listen({ host: env.AGENT_SERVER_HOST, port });
console.log(`Agent Ops API running at http://${env.AGENT_SERVER_HOST}:${port}`);
