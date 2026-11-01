import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSqliteDatabase, migrateSqliteDatabase } from "@simple-coding-agent/db";
import { parseEnvironment } from "@simple-coding-agent/security";

const env = parseEnvironment(process.env);
if (env.AGENT_DB_PATH !== ":memory:") mkdirSync(dirname(env.AGENT_DB_PATH), { recursive: true });

const database = createSqliteDatabase(env.AGENT_DB_PATH);
migrateSqliteDatabase(database);
database.sqlite.close();

console.log(`Migrated Agent Ops database at ${env.AGENT_DB_PATH}`);
