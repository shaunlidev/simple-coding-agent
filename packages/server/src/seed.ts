import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLiteRuntimeStore } from "@simple-coding-agent/runtime";
import { parseEnvironment } from "@simple-coding-agent/security";

const env = parseEnvironment(process.env);
if (env.AGENT_DB_PATH !== ":memory:") mkdirSync(dirname(env.AGENT_DB_PATH), { recursive: true });

const runtime = new SQLiteRuntimeStore({ path: env.AGENT_DB_PATH });
await runtime.seedDemo();
runtime.database.sqlite.close();

console.log(`Seeded Agent Ops runtime at ${env.AGENT_DB_PATH}`);
