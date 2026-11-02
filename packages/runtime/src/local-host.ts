import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { authenticateLocalIdentity, createCloudflareResolver, parseAuthUsers, parseEnvironment, parseUrlAllowlist, requireOperator, SafeNetwork } from "@simple-coding-agent/security";
import { SQLiteRuntimeStore } from "./index.js";
import { RuntimeScheduler } from "./scheduler.js";
import { createContentExecutor } from "./content-executor.js";
import type { ContentProviderFactory, executeContentRun } from "./content-agent.js";

export type LocalTaskHostOptions = {
  workspaceRoot: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  network?: SafeNetwork;
  providerFactory?: ContentProviderFactory;
  browser?: Parameters<typeof executeContentRun>[2]["browser"];
};

export function openLocalTaskHost(options: LocalTaskHostOptions) {
  const raw = options.env ?? process.env;
  const env = parseEnvironment(raw);
  // Authenticate before creating directories or opening/migrating a database.
  const identity = authenticateLocalIdentity(env, { id: raw.AGENT_LOCAL_USER, secret: raw.AGENT_LOCAL_SECRET });
  const path = resolve(options.workspaceRoot, env.AGENT_DB_PATH);
  const network = options.network ?? new SafeNetwork({ allowlist: parseUrlAllowlist(env.AGENT_URL_ALLOWLIST), ...(env.AGENT_DNS_MODE === "cloudflare" ? { resolve: createCloudflareResolver() } : {}) });
  mkdirSync(dirname(path), { recursive: true });
  const store = new SQLiteRuntimeStore({ path, network, secrets: [env.DEEPSEEK_API_KEY, env.AGENT_SESSION_SECRET, ...parseAuthUsers(env).map((user) => user.secret)].filter((value): value is string => Boolean(value)) });
  const scheduler = new RuntimeScheduler({ runtime: store, now: options.now, runAgent: createContentExecutor(store, { env, providerFactory: options.providerFactory, browser: options.browser }) });
  return { store, scheduler, env, identity, path, assertOperator: () => requireOperator(identity), async close() {
    try { await scheduler.stop(); } finally { store.database.sqlite.close(); }
  } };
}
export type LocalTaskHost = ReturnType<typeof openLocalTaskHost>;
