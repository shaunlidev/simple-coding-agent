export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type RuntimeRun = {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: "manual" | "schedule" | "demo";
  title: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  errorCount: number;
};

export type RuntimeStep = {
  id: string;
  name: string;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: string;
};

export type RuntimeSpan = {
  id: string;
  traceId: string;
  spanId: string;
  runId: string;
  parentId?: string;
  parentSpanId?: string;
  type: "root" | "scheduler" | "tool" | "browser" | "memory" | "llm" | "eval" | "security" | "delivery";
  name: string;
  status: "ok" | "error" | "denied";
  startedAt: string;
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  summary: string;
  attributes: Record<string, string | number | boolean>;
};

export type RuntimeSchedule = {
  id: string;
  title: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  nextRunAt: string;
  lastRunAt?: string;
  overlapPolicy: "skip" | "queue" | "cancel_previous";
};

export type RuntimeEvent = {
  id: string;
  runId: string;
  type: string;
  source: string;
  severity: "info" | "warning" | "error" | "critical";
  timestamp: string;
  payload: Record<string, unknown>;
};

export type MemoryState = {
  interests: string[];
  blockedTopics: string[];
  sourceWeights: Record<string, number>;
  recentFeedback: Array<{ itemId: string; signal: "clicked" | "saved" | "not_interested" | "dismissed"; timestamp: string }>;
  recentLessons: Array<{ title: string; principle: string; evidence: string; timestamp: string }>;
  preferenceDiffs: Array<{ field: "interests" | "blockedTopics" | "sourceWeights"; key: string; before?: string | number; after?: string | number; timestamp: string }>;
};

export type EvalGate = {
  id: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  score: number;
  evidence: string;
};

export type SecurityPosture = {
  toolPolicy: "least_privilege";
  secretScan: "passed" | "failed";
  sandbox: "enabled" | "planned";
  approvals: "required_for_high_risk";
  denials: Array<{ id: string; tool: string; reason: string; timestamp: string }>;
};

export type DeliveredContentItem = {
  id: string;
  runId: string;
  title: string;
  source: string;
  url?: string;
  summary: string;
  reason: string;
  score: number;
  status: "delivered" | "filtered" | "failed";
  evidence: string[];
  createdAt: string;
};

export type RuntimeSnapshot = {
  generatedAt: string;
  agent: {
    name: string;
    status: "idle" | "running" | "degraded" | "failed";
    mode: "demo" | "local" | "production";
  };
  latestRun?: RuntimeRun;
  schedules: RuntimeSchedule[];
  steps: RuntimeStep[];
  spans: RuntimeSpan[];
  metrics: {
    successRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    errorRate: number;
    toolFailures: number;
    evalPassRate: number;
    events: number;
  };
  memory: MemoryState;
  evals: EvalGate[];
  security: SecurityPosture;
  contentItems: DeliveredContentItem[];
  pipeline: {
    fetched: number;
    cleaned: number;
    deduped: number;
    ranked: number;
    delivered: number;
    failedSources: string[];
    digest?: string;
  };
  events: RuntimeEvent[];
};

let csrfToken: string | undefined;

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 && !input.startsWith("/api/auth/")) window.dispatchEvent(new Event("agent-auth-expired"));
    throw new ApiError(response.status, text || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export type AuthSession = { user: { id: string; role: "viewer" | "operator" }; csrfToken: string };

export async function fetchSession(): Promise<AuthSession | null> {
  try {
    const session = await requestJson<AuthSession>("/api/auth/session");
    csrfToken = session.csrfToken;
    return session;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { csrfToken = undefined; return null; }
    throw error;
  }
}

export async function login(credentials: { id: string; secret: string }): Promise<AuthSession> {
  const session = await requestJson<AuthSession>("/api/auth/login", { method: "POST", body: JSON.stringify(credentials) });
  csrfToken = session.csrfToken;
  return session;
}

export async function logout(): Promise<void> {
  await requestJson("/api/auth/logout", { method: "POST", body: "{}" });
  csrfToken = undefined;
}

export async function fetchSnapshot(): Promise<RuntimeSnapshot> {
  return requestJson<RuntimeSnapshot>("/api/snapshot");
}

export async function runNow(): Promise<{ accepted: true; runId: string }> {
  return requestJson<{ accepted: true; runId: string }>("/api/runs/run-now", { method: "POST", body: "{}" });
}

export async function patchSchedule(id: string, patch: Partial<Pick<RuntimeSchedule, "enabled" | "cron" | "timezone" | "overlapPolicy">>): Promise<RuntimeSchedule> {
  return requestJson<RuntimeSchedule>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
