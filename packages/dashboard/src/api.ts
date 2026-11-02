export type RunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "skipped";
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
  lastTrigger?: "manual" | "schedule" | "demo";
  lastTriggerReason?: string;
  lastScheduledFor?: string;
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
  status: "delivered" | "already_delivered" | "filtered" | "failed";
  evidence: string[];
  citations?: { documentId: string; readUrl: string; quote: string; hash: string }[];
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
    outcome?: "delivered" | "no_new_items" | "legacy_incomplete";
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

export async function runNow(key: string, taskId?: string): Promise<{ accepted: true; runId: string }> {
  return requestJson<{ accepted: true; runId: string }>("/api/runs/run-now", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(taskId ? { taskId } : {}) });
}

export type ContentTask = { id: string; title: string; instruction: string; model: string; mode?: "live" | "demo"; sources: { id: string; kind: "rss" | "url" | "browser" | "mock"; url: string; query?: string }[] };
export type ContentTaskRecord = { definition: ContentTask; revision: number; updatedAt: string };
export const fetchTasks = () => requestJson<{ tasks: ContentTaskRecord[]; demoMode: boolean; defaultModel: string }>("/api/tasks");
export const saveTask = (definition: ContentTask) => requestJson<ContentTaskRecord>(`/api/tasks/${encodeURIComponent(definition.id)}`, { method: "PUT", body: JSON.stringify({ definition, expectedRevision: 0 }) });

export type RunDetail = {
  run: RuntimeRun;
  events: RuntimeEvent[];
  result: { outcome: "delivered" | "no_new_items" | "legacy_incomplete"; digest: string; items: DeliveredContentItem[]; deliveredCount: number } | null;
  memoryContext: { hash: string; context: { capturedAt: string; profile: Pick<MemoryState, "interests" | "blockedTopics" | "sourceWeights">; knowledge: MemoryHit[]; practice: { id: string; hash: string; rules: PracticeRule[] } | null; feedback: FeedbackRecord[] } } | null;
};

export const fetchRuns = () => requestJson<{ runs: RuntimeRun[] }>("/api/runs");
export const fetchRun = (id: string) => requestJson<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
export const cancelRun = (id: string) => requestJson<{ runId: string; status: RunStatus }>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
export const createSchedule = (input: { id: string; taskId: string; title: string; cron: string; timezone: string; overlapPolicy: RuntimeSchedule["overlapPolicy"] }) => requestJson<RuntimeSchedule>("/api/schedules", { method: "POST", body: JSON.stringify(input) });
export const runSchedule = (input: { id: string; key: string }) => requestJson<{ runId: string }>(`/api/schedules/${encodeURIComponent(input.id)}/run-now`, { method: "POST", headers: { "idempotency-key": input.key }, body: "{}" });

export async function patchSchedule(id: string, patch: Partial<Pick<RuntimeSchedule, "enabled" | "cron" | "timezone" | "overlapPolicy">>): Promise<RuntimeSchedule> {
  return requestJson<RuntimeSchedule>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export type FeedbackSignal = "clicked" | "saved" | "not_interested" | "dismissed";
export type FeedbackRecord = { id: string; item_id: string; signal: FeedbackSignal; actor: string; created_at: string };
export type MemoryHit = { id: string; kind: string; content: string; metadata: Record<string, unknown>; source: { actor: string; trust: string; createdAt: string } };
export type PracticeRule = { kind: "minimum_quotes"; count: number } | { kind: "source_delivery_cap"; maximum: number } | { kind: "source_rank_bias"; sourceId: string; delta: number };
export type PracticeEvidence = { kind: "feedback"; feedbackId: string } | { kind: "run_result"; runId: string; contentId: string };
export type PracticeVersion = { id: string; hash: string; actor: string; createdAt: string; definition: { title: string; principle: string; parentId: string | null; rules: PracticeRule[]; evidence: { reference: PracticeEvidence; source: string; contentId: string; runId: string; summary: string; signal?: FeedbackSignal; hash: string }[] } };
export type PracticeList = {
  state: { version_id: string | null; revision: number };
  versions: PracticeVersion[];
  reviews: { id: string; version_id: string; decision: "approved" | "rejected"; reason: string; actor: string; created_at: string }[];
  evaluations: { id: string; report: { versionId: string; versionHash: string; baselineRevision: number; purpose: "candidate" | "build-revalidation"; compilerHash: string; evidenceKind: string; passed: boolean; checks: { name: string; passed: boolean; expected: string; actual: string }[] } }[];
  activations: { id: string; from_id: string | null; to_id: string | null; action: string; actor: string; created_at: string; revision: number }[];
};
export type MemoryExport = { memory: MemoryState; entries: { id: string; kind: string; content: string; metadata: Record<string, unknown>; sourceTrust: string; createdAt: string }[]; feedback: FeedbackRecord[]; practices: PracticeList; historyPolicy: string };
export const fetchMemory = () => requestJson<MemoryExport>("/api/memory/export");
export const fetchPractices = () => requestJson<PracticeList>("/api/memory/practices");
export const saveFeedback = (input: { itemId: string; signal: FeedbackSignal; requestKey: string }) => requestJson<{ feedback: { id: string; changed: boolean } }>("/api/memory/feedback", { method: "POST", body: JSON.stringify(input) });
export const savePreferences = (input: Partial<Pick<MemoryState, "interests" | "blockedTopics" | "sourceWeights">>) => requestJson<MemoryState>("/api/memory/preferences", { method: "PATCH", body: JSON.stringify(input) });
export const addKnowledge = (input: { content: string; metadata: { url?: string } }) => requestJson("/api/memory/entries", { method: "POST", body: JSON.stringify({ ...input, kind: "knowledge" }) });
export const searchKnowledge = (query: string) => requestJson<{ results: MemoryHit[] }>(`/api/memory/search?q=${encodeURIComponent(query)}`);
export const proposePractice = (input: { title: string; principle: string; rules: PracticeRule[]; evidence: PracticeEvidence[]; parentId?: string }) => requestJson<PracticeVersion>("/api/memory/practices", { method: "POST", body: JSON.stringify(input) });
export const reviewPractice = (input: { id: string; decision: "approved" | "rejected"; reason: string }) => requestJson(`/api/memory/practices/${encodeURIComponent(input.id)}/review`, { method: "POST", body: JSON.stringify({ decision: input.decision, reason: input.reason }) });
export const evaluatePractice = (id: string) => requestJson<PracticeList["evaluations"][number]>(`/api/memory/practices/${encodeURIComponent(id)}/evaluate`, { method: "POST", body: "{}" });
export const activatePractice = (input: { id: string; evaluationId: string; expectedRevision: number }) => requestJson(`/api/memory/practices/${encodeURIComponent(input.id)}/activate`, { method: "POST", body: JSON.stringify({ evaluationId: input.evaluationId, expectedRevision: input.expectedRevision, confirmation: "activate-practice" }) });
export const rollbackPractice = (expectedRevision: number) => requestJson("/api/memory/practices/rollback", { method: "POST", body: JSON.stringify({ expectedRevision, confirmation: "rollback-practice" }) });
export const requestMemoryClear = (runId: string) => requestJson<{ id: string }>("/api/security/approvals", { method: "POST", body: JSON.stringify({ runId, tool: "memory_clear", args: { confirmation: "clear-memory" } }) });
export async function approveMemoryClear(input: { runId: string; approvalId: string }) {
  await requestJson(`/api/security/approvals/${encodeURIComponent(input.approvalId)}/approve`, { method: "POST", body: "{}" });
  return requestJson("/api/memory", { method: "DELETE", body: JSON.stringify(input) });
}
