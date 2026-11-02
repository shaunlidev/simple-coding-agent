import type { SQLiteRuntimeStore } from "./index.js";
import { createContentExecutor } from "./content-executor.js";
import { RuntimeScheduler } from "./scheduler.js";
import { RuntimeRetention } from "./retention.js";
import type { MonitoringOptions } from "./monitoring.js";

export function createTaskRuntime(options: Parameters<typeof createContentExecutor>[1] & {
  runtime: SQLiteRuntimeStore; now?: () => Date; monitoring?: MonitoringOptions;
}) {
  const { env, runtime } = options;
  const scheduler = new RuntimeScheduler({ runtime, now: options.now, runAgent: createContentExecutor(runtime, options), monitoring: {
    ...options.monitoring,
    policy: { heartbeatMs: env.AGENT_HEARTBEAT_MS, staleMs: env.AGENT_HEARTBEAT_STALE_MS, pollMs: env.AGENT_MONITOR_POLL_MS, overdueMs: env.AGENT_MONITOR_OVERDUE_MS, ...options.monitoring?.policy },
  } });
  // The caller owns the database and may close it only after this drain barrier.
  return { scheduler, monitoring: scheduler.monitoring, retention: new RuntimeRetention(runtime), close: () => scheduler.stop() };
}
