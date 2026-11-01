# Agent Ops Dashboard Specification

## Product Boundary

This product is an operations dashboard for a personalized content agent. It is not a documentation showcase. Product specifications, implementation plans, and explanatory prose belong in `README.md` and `docs/`; the dashboard renders runtime state only.

The dashboard must let a reviewer operate and inspect an agent:

- Start a run manually.
- See scheduler state and trigger metadata.
- Watch runtime events as they happen.
- Inspect pipeline progress from fetch through delivery.
- Debug run traces, cost, latency, tokens, tool calls, and errors.
- Review memory, feedback, eval gates, security posture, and denied actions.

## Technology Stack

Target stack:

- TypeScript monorepo with npm workspaces.
- Fastify backend API.
- React + Vite dashboard.
- Tailwind CSS with shadcn-style components.
- TanStack Query for API state.
- Server-Sent Events for live runtime updates.
- SQLite for MVD storage with Drizzle ORM migrations and queries.
- node-cron scheduler backed by persisted schedule records.
- Playwright for browser read-only collection.
- DeepSeek API provider for LLM calls.
- Node test runner plus JSON eval harness reports.
- Structured logs, spans, metrics, and OTel-compatible observability shapes.
- Dockerfile and docker-compose for deployment readiness.
- Env schema, secret redaction, tool registry, approval gate, audit log, and URL allowlist for security.

Upgrade path:

- SQLite -> Postgres.
- node-cron -> Temporal, Inngest, or Trigger.dev.
- Local observability -> OpenTelemetry export to Langfuse, LangSmith, Grafana, or Datadog.

## Runtime Data Model

Authoritative state is derived from runtime data:

- `RuntimeEvent`: append-only event record with `runId`, `type`, `source`, `severity`, timestamp, and payload.
- `RuntimeRun`: projected run state.
- `RuntimeStep`: projected pipeline step state.
- `RuntimeSpan`: trace waterfall item for scheduler, tool, browser, memory, LLM, eval, security, and delivery work.
- `RuntimeSchedule`: recurring trigger state.
- `ContentItem`: delivered recommendation with ranking evidence and feedback status.
- `MemoryState`: preferences, feedback, source weights, and lessons.
- `EvalGate`: release gate status and evidence.
- `SecurityPosture`: tool policy, secret scan, sandbox, approval mode, and denied actions.

## Acceptance Criteria

- The dashboard does not read or display static spec/demo prose as its primary source of truth.
- `GET /api/snapshot` returns current agent, run, event, pipeline, trace, schedule, memory, eval, and security state.
- `GET /api/events/stream` streams snapshots and runtime events through SSE.
- `POST /api/runs/run-now` starts a new run and appends events.
- Schedule pause/resume and schedule run-now use the same runtime event path.
- Content feedback updates memory and is visible in subsequent ranking evidence.
- Untrusted memory writes are rejected and recorded as audit events.
- High-risk tools require approval and denied actions are visible in the security audit.
- Runtime events are append-only and can reconstruct the latest run.
- Malformed events are rejected by the runtime schema validator.
- Dashboard controls have clear loading/disabled states.
- No API keys or secrets are rendered in runtime events, traces, logs, or UI.
- `npm run check`, dashboard build, and dashboard eval pass before deployment.
