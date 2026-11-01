# 0008 Agent Ops Dashboard Production Plan

## Acceptance reopened on 2026-11-01

The review of commit `797ccb8` disproved the earlier overall completion claim. The verification notes below are historical records, not current release approval. Local test success did not prove clean installation, production execution, authorization, or container readiness.

Confirmed gaps include a missing local TypeScript dependency, a failed Docker build, an unauthenticated API, client-asserted approvals, a mock dashboard execution path, fixed usage metrics, unearned passing eval states, missing results after repeated runs, ignored schedule timezones, and ineffective cancellation.

Keep every requirement and the locked stack in this plan. Execute the proposed repair batches in [0009 Agent Ops acceptance recovery](0009-agent-ops-acceptance-recovery.md). That document maps each repair back to the original phases. It explicitly changes the repair order to address build and authorization before connecting production tools. It does not remove original acceptance criteria.

The R1-R10 repair order is proposed for review. Once approved, it governs the order of repair work. Each original phase remains open until all its original acceptance criteria have passing evidence. Preparing the repair documents does not approve implementation or close a phase.

Deployment acceptance requires an actual container build, healthy running services, and an end-to-end browser check. Dockerfile text checks and host-process health checks alone cannot close Phase 10. Keep this plan active until the original criteria and the repair gates have current evidence.

## Execution Contract

Every phase must follow the same sequence:

1. Phase plan.
2. Acceptance criteria.
3. Implementation.
4. Verification.
5. Phase close.

No phase may start implementation until its plan and acceptance criteria are written in this document. No later phase may start until the current phase has passing verification evidence.

## Locked Technology Stack

- Language: TypeScript.
- Monorepo: npm workspaces.
- Backend API: Fastify.
- Dashboard: React + Vite.
- UI: Tailwind CSS with shadcn-style components.
- Client state: TanStack Query.
- Live updates: Server-Sent Events.
- Database: SQLite for MVD, upgrade path to Postgres.
- ORM: Drizzle ORM.
- Scheduler: node-cron backed by persisted schedule records.
- Browser tool: Playwright.
- LLM: DeepSeek API provider.
- Evals: Node test runner plus JSON harness reports.
- Observability: structured logs, spans, metrics, OTel-compatible shapes.
- Deployment: Dockerfile and docker-compose.
- Security: env schema, secret redaction, tool registry, approval gate, audit log, URL allowlist.

## Phase 0: Cleanup And Direction Reset

### Plan

- Remove generated runtime/demo artifacts from source control candidates.
- Replace the earlier file-backed/no-dependency planning language with the locked production stack.
- Keep useful work that remains aligned:
  - DeepSeek provider and streaming/tool-call fixes.
  - Browser tool tests.
  - Task/content pipeline experiments as reference only until Phase 6.
  - Runtime/dashboard code only as a temporary migration reference until Phase 1-4 replace it.
- Remove or stop relying on:
  - `docs/demo/**` generated portfolio artifacts.
  - `docs/runtime/**` generated file-backed runtime state.
  - UI copy that presents specs/plans as product content.
- Document the phase-by-phase gate so future implementation cannot skip plan -> AC -> implementation -> verification.

### Acceptance Criteria

- `docs/demo` and `docs/runtime` contain no generated runtime artifacts.
- The active 0008 plan names the locked Fastify/React/SQLite/Drizzle stack.
- The Agent Ops spec does not endorse the no-dependency file-backed implementation as the target architecture.
- `git status` does not show `.env`, API keys, tokens, or generated runtime JSON/JSONL under `docs/runtime`.
- `npm run check` passes.

### Verification Evidence

- Removed generated `docs/demo/**` and `docs/runtime/**` artifacts from source candidates.
- Removed old `demo:agent`, `harness:portfolio`, portfolio harness script, and portfolio harness eval.
- Updated README, HARNESS, TESTING, and Agent Ops spec to point at the production Agent Ops plan instead of the static portfolio artifact flow.
- `find docs/demo docs/runtime -type f` returns no files.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run eval` passed: 8 pass, 1 skipped.
- `npm run test` passed: 119 pass, 1 skipped.

## Phase 1: Repo And Dependency Foundation

### Plan

- Install production dependencies:
  - `fastify`
  - `@fastify/cors`
  - `zod`
  - `drizzle-orm`
  - `better-sqlite3`
  - `node-cron`
  - `vite`
  - `react`
  - `react-dom`
  - `@tanstack/react-query`
  - `tailwindcss`
  - relevant type packages
- Reorganize or add packages:
  - `packages/db`
  - `packages/server`
  - `packages/runtime`
  - `packages/dashboard`
  - `packages/security`
- Define workspace build order and package boundaries.
- Keep existing coding-agent/TUI packages compiling while the Agent Ops path is added.

### Acceptance Criteria

- `npm install` succeeds.
- `npm run check` passes.
- `npm run build` passes.
- `npm run check:package-boundaries` passes.
- No package imports another package's `src` files through relative paths.

### Verification Evidence

- Installed and locked production dependencies: Fastify, `@fastify/cors`, Zod, Drizzle ORM, better-sqlite3, node-cron, React, React DOM, TanStack Query, Vite, React plugin, Tailwind CSS, and relevant type packages.
- Added workspace packages:
  - `packages/db`
  - `packages/security`
  - `packages/server`
- Added root build coverage for db/security/server packages.
- Added db/security/server foundation tests.
- `npm ls fastify @fastify/cors zod drizzle-orm better-sqlite3 node-cron react react-dom @tanstack/react-query vite @vitejs/plugin-react tailwindcss --depth=0` confirmed installed versions.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run test` passed: 122 pass, 1 skipped.
- `npm run eval` passed: 8 pass, 1 skipped.

## Phase 2: Database And Runtime Event System

### Plan

- Add Drizzle SQLite schema for:
  - `runs`
  - `runtime_events`
  - `spans`
  - `metrics`
  - `schedules`
  - `content_items`
  - `memory_entries`
  - `feedback`
  - `eval_reports`
  - `security_audit`
  - `tool_approvals`
- Add migration command.
- Implement append-only event writer.
- Implement event projector for run state, step state, spans, metrics, and dashboard snapshot.
- Replace file-backed runtime state with SQLite.

### Acceptance Criteria

- Runtime events are append-only.
- Malformed events are rejected before persistence.
- Latest run can be reconstructed from events.
- Migration can be run repeatedly.
- Snapshot reads from SQLite, not generated JSON fixtures.
- Runtime tests pass.

### Verification Evidence

- Added Drizzle SQLite schema coverage for `runs`, `runtime_events`, `spans`, `metrics`, `schedules`, `content_items`, `memory_entries`, `feedback`, `eval_reports`, `security_audit`, and `tool_approvals`.
- Added idempotent SQLite migration function.
- Added `SQLiteRuntimeStore` with event validation, append-only event persistence, event replay, and run projection.
- Added DB migration tests and SQLite runtime replay tests.
- `npm run check` passed.
- `npm run build` passed.
- `npm run test` passed: 124 pass, 1 skipped.
- `npm run eval` passed: 8 pass, 1 skipped.
- `npm run check:package-boundaries` passed.

## Phase 3: Fastify API And SSE

### Plan

- Add Fastify server package.
- Implement:
  - `GET /healthz`
  - `GET /readyz`
  - `GET /api/snapshot`
  - `GET /api/runs`
  - `GET /api/runs/:id`
  - `POST /api/runs/run-now`
  - `GET /api/events/stream`
  - `GET /api/schedules`
  - `POST /api/schedules`
  - `PATCH /api/schedules/:id`
- Validate request/response payloads with schemas.
- Implement structured error envelopes and secret-safe logging.

### Acceptance Criteria

- API starts through an npm script.
- `run-now` creates a run and emits events.
- SSE streams runtime events without page refresh.
- Invalid API payloads return typed 4xx errors.
- Errors do not expose API keys, stack traces, or raw secret-like values.

### Verification Evidence

- Replaced placeholder server responses with Fastify endpoints backed by `SQLiteRuntimeStore`.
- Added `npm run server` and `packages/server/src/entry.ts` so the API starts through an npm script.
- Implemented:
  - `GET /healthz`
  - `GET /readyz`
  - `GET /api/snapshot`
  - `GET /api/runs`
  - `GET /api/runs/:id`
  - `POST /api/runs/run-now`
  - `GET /api/events/stream`
  - `GET /api/schedules`
  - `POST /api/schedules`
  - `PATCH /api/schedules/:id`
- Added Zod validation for schedule create/patch payloads.
- Added structured error envelopes with secret redaction.
- Added SSE `once=1` test path for deterministic automated verification.
- Local HTTP verification passed on `127.0.0.1:4175`:
  - `/healthz` returned `{ "ok": true }`.
  - `POST /api/runs/run-now` returned an accepted run ID.
  - `/api/runs` returned a completed run.
  - `/api/events/stream?once=1` returned `event: snapshot` and `event: runtime-event`.
  - invalid schedule payload returned typed `INVALID_SCHEDULE` 400 response.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run test` passed: 127 pass, 1 skipped.
- `npm run eval` passed: 8 pass, 1 skipped.

## Phase 4: React Agent Ops Dashboard

### Plan

- Replace static HTML dashboard with React/Vite.
- Use TanStack Query for API reads.
- Use SSE to update query cache.
- Implement pages:
  - Cockpit
  - Runs
  - Run detail / trace
  - Scheduler
  - Content pipeline
  - Inbox / delivery
  - Memory
  - Evals
  - Security
  - Settings

### Acceptance Criteria

- First screen is an operations cockpit.
- No dashboard section presents spec/readme content as product UI.
- Run now, pause schedule, and view trace are usable.
- Desktop and mobile have no horizontal overflow.
- Playwright screenshot eval passes.
- All data comes from API responses.

### Verification Evidence

- Replaced the old static dashboard with a React + Vite dashboard.
- Dashboard client uses TanStack Query for `/api/snapshot` reads.
- Dashboard client subscribes to `/api/events/stream` with `EventSource` and invalidates runtime snapshot data on SSE updates.
- Implemented operations cockpit as the first screen with agent status, latest run, metrics, and `Run now`.
- Implemented runtime dashboard sections:
  - Run Trace
  - Scheduler
  - Content Pipeline
  - Event Stream
  - Memory
  - Eval Harness
  - Observability
  - Security
- Removed the old static dashboard scripts and generated-demo UI source files under `packages/dashboard/public` and `packages/dashboard/scripts`.
- Updated dashboard eval to inspect Vite build output and reject `docs/demo` / `docs/runtime` dependencies.
- Local browser verification passed against Fastify API on `127.0.0.1:4175` and Vite dashboard on `127.0.0.1:4176`:
  - Desktop viewport `1440x1000`: cockpit, Run now, Scheduler, Content Pipeline, Memory, Eval Harness, Security, and Run Trace visible; no horizontal overflow.
  - Mobile viewport `390x844`: cockpit, Run now, Scheduler, Content Pipeline, Memory, Eval Harness, Security, and Run Trace visible; no horizontal overflow.
  - `Run now` button created a fresh run and refreshed dashboard runtime data.
- Playwright screenshots generated for visual inspection:
  - `/private/tmp/agent-ops-dashboard-desktop.png`
  - `/private/tmp/agent-ops-dashboard-mobile.png`
- `npm run check` passed.
- `npm run dashboard:build` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run test` passed: 127 pass, 1 skipped.
- `npm run eval` passed: 8 pass, 1 skipped.

## Phase 5: Scheduler And Trigger Runtime

### Plan

- Implement node-cron scheduler backed by DB records.
- Support cron, interval, manual run now, pause, resume.
- Implement overlap policies:
  - `skip`
  - `queue`
  - `cancel_previous`
- Emit scheduler events into the runtime event system.

### Acceptance Criteria

- Daily 9 AM schedule can be configured.
- Paused schedule does not trigger.
- Manual and scheduled runs share the same run path.
- Overlap policy behavior is tested.
- Dashboard shows `nextRunAt`, `lastRunAt`, enabled state, and trigger reason.

### Verification Evidence

- Added `RuntimeScheduler` backed by persisted SQLite schedule records.
- Server startup now enables the node-cron scheduler in `packages/server/src/entry.ts`.
- Added deterministic scheduler tick endpoint:
  - `POST /api/scheduler/tick`
- Added schedule-scoped manual run endpoint:
  - `POST /api/schedules/:id/run-now`
- Existing manual run endpoint now uses the scheduler runtime path:
  - `POST /api/runs/run-now`
- Schedule records now persist `nextRunAt`, `lastRunAt`, enabled state, cron expression, timezone, and overlap policy.
- `nextRunAt` calculation covers:
  - daily 9 AM cron such as `0 9 * * *`
  - interval syntax such as `@every 6h`
  - common every-N-hours cron such as `0 */6 * * *`
- Paused schedules are ignored by due-schedule ticks.
- Scheduled runs reuse the same `runDemoAgent` path as manual runs, with `trigger: "schedule"` and schedule task metadata.
- Implemented and tested overlap policies:
  - `skip`
  - `queue`
  - `cancel_previous`
- Scheduler decisions emit `scheduler.task_due` runtime events with trigger reason metadata.
- Dashboard Scheduler rows now show `nextRunAt`, `lastRunAt`, enabled state, and latest trigger reason.
- Added runtime tests for next-run calculation, due/paused behavior, scheduled run projection, and overlap policies.
- Added server test for deterministic scheduler tick triggering a due schedule through the shared run path.
- Updated dashboard eval to verify schedule trigger/last-run UI wiring in Vite build output.
- Targeted runtime/server scheduler tests passed: 11 pass.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run dashboard:build` passed.
- `npm run test` passed: 131 pass, 1 skipped.
- `npm run eval` passed: 8 pass, 1 skipped.

## Phase 6: Content Pipeline

### Plan

- Implement source adapters:
  - mock
  - RSS
  - URL fetch
  - Playwright browser read-only
- Implement pipeline:
  - fetch
  - normalize
  - clean
  - dedupe
  - rank
  - summarize
  - deliver
- Persist content, ranking evidence, digest output, spans, metrics, and errors.

### Acceptance Criteria

- Duplicate URLs are not recommended twice.
- Similar content can be merged.
- One failed source does not fail the batch unless all sources fail.
- Every delivered item has source, summary, reason, score, and evidence.
- Pipeline state is visible in dashboard.

### Verification Evidence

- Added SQLite-backed content pipeline in `packages/runtime`.
- Implemented source adapters:
  - mock
  - RSS
  - URL fetch
  - browser read-only via injectable browser adapter
- Implemented pipeline stages:
  - fetch
  - normalize / clean
  - canonical URL dedupe
  - similar-content merge
  - preference/evidence ranking
  - extractive summary
  - delivery digest
- Persisted delivered content items to SQLite `content_items`.
- Added `evidence_json` migration for ranking evidence.
- Runtime snapshot now includes:
  - `contentItems`
  - `pipeline.fetched`
  - `pipeline.cleaned`
  - `pipeline.deduped`
  - `pipeline.ranked`
  - `pipeline.delivered`
  - `pipeline.failedSources`
  - `pipeline.digest`
- Dashboard Content Pipeline section now shows fetched/deduped/delivered counts and delivered items with source, summary, reason, score, and evidence.
- One failed source is recorded as warning metadata and does not fail the batch when other sources return content.
- The pipeline throws only when every source fails.
- Duplicate URLs are not delivered twice.
- Similar content is merged before delivery.
- Added runtime tests for duplicate URL removal, similar-content merge, failed-source tolerance, all-source failure, content persistence, ranking evidence, and dashboard snapshot visibility.
- Updated dashboard eval to verify delivered item UI wiring in Vite build output.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run dashboard:build` passed.
- `npm run test` passed: 133 pass, 1 skipped.
- `npm run eval` passed: 8 pass, 1 skipped.

## Phase 7: Memory, Preference, And RAG

### Plan

- Implement memory tables for preferences, feedback, lessons, and retrieved knowledge.
- Use SQLite FTS for MVD retrieval.
- Use preference and feedback weights in ranking.
- Add memory write guard:
  - trusted source requirement
  - injection-like text rejection
  - user delete/export path

### Acceptance Criteria

- Save/not interested feedback changes next-run ranking.
- External prompt injection cannot directly write long-term memory.
- User can export and clear memory.
- Dashboard shows preference diffs.
- Memory evals pass.

### Verification Evidence

- Added SQLite-backed memory entries for:
  - preferences
  - blocked topics
  - source weights
  - lessons
  - retrieved knowledge
- Added SQLite-backed feedback records.
- Added SQLite FTS5 virtual table for memory/RAG retrieval.
- Runtime ranking now reads persisted memory and feedback instead of only using default memory.
- Feedback signals affect next-run ranking:
  - `saved` increases item score.
  - `clicked` increases item score.
  - `not_interested` decreases item score.
  - `dismissed` decreases item score.
- Added guarded long-term memory writes:
  - external sources cannot directly write memory.
  - injection-like text is rejected.
  - trusted user/system/tool writes are allowed.
- Guarded write failures are exposed as typed API errors and emit `security.policy.denied` events.
- Added user memory export and clear path:
  - `GET /api/memory/export`
  - `DELETE /api/memory`
- Added memory APIs:
  - `POST /api/memory/entries`
  - `POST /api/memory/feedback`
  - `GET /api/memory/search?q=...`
- Dashboard Memory section now shows preference diffs from persisted memory and feedback updates.
- Added runtime tests for feedback-driven ranking changes, preference diffs, memory guard rejection, FTS retrieval, export, and clear.
- Added server tests for feedback, export, search, clear, guarded write rejection, and security audit event visibility.
- Updated dashboard eval to verify Preference Diffs UI wiring in Vite build output.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run dashboard:build` passed.
- `npm run test` passed: 136 pass, 1 skipped.
- `npm run eval` passed: 8 pass, 1 skipped.

## Phase 8: Eval And Harness

### Plan

- Add eval datasets for:
  - runtime replay
  - scheduler overlap
  - content dedupe
  - ranking with feedback
  - tool-call order
  - memory poisoning
  - prompt injection
  - secret redaction
  - cost/latency budget
- Store eval reports in DB.
- Render recent eval gate status in dashboard.

### Acceptance Criteria

- `npm run eval` is a release gate.
- Every core module has at least one eval.
- Failed eval can be traced to run/span/event evidence.
- Dashboard shows pass/fail/evidence.

### Verification Evidence

- Added Agent Ops harness eval:
  - `evals/agent-ops-harness.eval.ts`
- Added release-gate eval datasets for:
  - runtime replay
  - scheduler overlap
  - content dedupe
  - ranking with feedback
  - tool-call order
  - memory poisoning
  - prompt injection
  - secret redaction
  - cost/latency budget
- Eval reports are persisted to SQLite `eval_reports`.
- `SQLiteRuntimeStore` now supports:
  - `saveEvalReport`
  - `listEvalReports`
- Runtime snapshot now renders persisted eval reports when present; otherwise it falls back to default demo eval gates.
- Eval report evidence includes traceable run/event metadata such as `runId` and `eventIds`.
- Added failed-eval traceability test to prove dashboard-visible failed evals include run/event evidence.
- Existing dashboard Eval Harness section consumes snapshot `evals`, so pass/fail/evidence from persisted eval reports is visible in the dashboard.
- Cleaned stale `packages/runtime/dist/scheduler.*` build artifacts after scheduler source was folded into runtime `index.ts`.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run dashboard:build` passed.
- `npm run test` passed: 138 pass, 1 skipped.
- `npm run eval` passed: 10 pass, 1 skipped.

## Phase 9: Observability And Monitoring

### Plan

- Implement OTel-compatible span shape.
- Create root trace per run.
- Add child spans for scheduler, source adapters, browser, LLM, memory, eval, delivery, and security.
- Add metrics:
  - latency p50/p95
  - cost
  - tokens
  - error rate
  - tool failures
  - eval pass rate

### Acceptance Criteria

- Every run has a complete trace.
- Every LLM call records model, tokens, cost, and latency.
- Every tool call records status, error, and duration.
- Errors can be filtered by severity/source.
- Budget overflow can stop or degrade a run.

### Verification Evidence

- Runtime snapshot now projects OTel-compatible spans from runtime events.
- Every run has a root span with stable `traceId` and `spanId`.
- Child spans include:
  - `traceId`
  - `spanId`
  - `parentSpanId`
  - run/event attributes
- Added child span coverage for scheduler, browser/source fetch, tools, memory, LLM, eval, delivery, and security.
- LLM spans record:
  - model
  - input tokens
  - output tokens
  - cost
  - latency
- Metrics now include:
  - success rate
  - p50 latency
  - p95 latency
  - cost
  - input tokens
  - output tokens
  - error rate
  - tool failures
  - eval pass rate
  - event count
- Added budget overflow behavior to content pipeline:
  - `throw` mode emits `run.failed` and stops.
  - `degrade` mode emits warning summary span, skips costly summary, and continues delivery.
- Added event filtering API:
  - `GET /api/events?severity=...&source=...&runId=...`
- Dashboard metrics now show P50 latency and tool failures.
- Dashboard trace table now shows `traceId` and `spanId`.
- Added runtime tests for complete trace projection, root/child span linkage, LLM token/cost/model attributes, and metrics.
- Added runtime tests for budget stop/degrade behavior.
- Added server test for severity/source event filtering.
- Updated dashboard eval to verify observability UI wiring.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run dashboard:build` passed.
- `npm run test` passed: 141 pass, 1 skipped.
- `npm run eval` passed: 10 pass, 1 skipped.

## Phase 10: Security And Deployment Ready

### Plan

- Remove the remaining file-backed Agent Ops runtime path so the production dashboard has one source of truth:
  - keep SQLite runtime as the Agent Ops runtime;
  - remove old `FileRuntimeStore` reads/writes for `docs/runtime/*.json` and `events.jsonl`;
  - update runtime tests to verify SQLite replay only.
- Implement production env hygiene:
  - expand env schema for server host/port, dashboard API base, CORS origin, URL allowlist, and optional production enforcement;
  - keep `.env.example` commit-safe and document `.env` as local-only;
  - make missing required production keys fail with clear validation messages.
- Implement secret controls:
  - harden redaction for API keys, bearer tokens, `.env`-style assignments, and DeepSeek key names;
  - add a secret scanner that can scan strings and selected tracked files;
  - ensure API errors and audit records are redacted before returning to the dashboard.
- Implement tool security controls:
  - define a typed tool registry with risk tiers and read-only/write classification;
  - enforce URL allowlist checks for browser navigation and URL collection;
  - require approval for high-risk or write tools;
  - keep browser snapshot/navigation read-only by default, and block type/click/publish without approval.
- Implement auditability:
  - persist security audit records and tool approval records in SQLite;
  - expose security audit/approval APIs for the dashboard and tests;
  - project current security posture from real audit records where possible.
- Implement deployment readiness:
  - add migration and seed npm scripts;
  - add Dockerfile, docker-compose, healthcheck, and production env example;
  - add CI workflow for check/build/package-boundaries/dashboard/test/eval gates;
  - update README with fresh clone, local dashboard, Docker, security, and release-gate instructions.

### Acceptance Criteria

- `.env` is not tracked, and repo scans show no committed `.env`, SQLite DB, JSONL runtime logs, or screenshots.
- Missing production-required keys produce clear, typed env validation errors.
- Keys never appear in API errors, runtime events, traces, audit records, eval evidence, or dashboard UI payloads.
- High-risk/write tools cannot run without approval; denied attempts produce redacted audit evidence.
- Browser and URL-fetch tools reject URLs outside the configured allowlist.
- Dashboard/server can read security audit and approval state from the API.
- Migration and seed commands are idempotent.
- Dockerfile and docker-compose define health/readiness checks against the Fastify app.
- A fresh clone can run locally by following README without needing hidden local state.
- `npm run check && npm run build && npm run check:package-boundaries && npm run dashboard:build && npm run test && npm run eval` passes.

### Verification Evidence

- Removed the old file-backed Agent Ops runtime implementation:
  - deleted `FileRuntimeStore` from runtime source;
  - removed runtime reads/writes for `docs/runtime/*.json`, `events.jsonl`, and `security.json`;
  - updated runtime replay and malformed-event tests to use `SQLiteRuntimeStore`.
- Expanded env schema in `@simple-coding-agent/security`:
  - server host/port;
  - dashboard API base URL;
  - CORS origin;
  - URL allowlist;
  - production secret enforcement.
- Updated `.env.example` with commit-safe local defaults.
- Added hardened redaction and secret scanning:
  - DeepSeek/OpenAI-style keys;
  - API key assignments;
  - bearer tokens;
  - token/password assignments;
  - safe placeholder handling for docs and examples.
- Added typed tool security controls:
  - tool registry;
  - low/medium/high risk tiers;
  - read-only/write classification;
  - URL allowlist enforcement;
  - approval gate for high-risk/write tools.
- Added SQLite-backed security audit and tool approval persistence:
  - `recordSecurityAudit`
  - `listSecurityAudit`
  - `recordToolApproval`
  - `listToolApprovals`
- Dashboard security posture now projects from real audit records.
- Added server security APIs:
  - `GET /api/security/audit`
  - `POST /api/security/tool-check`
  - `POST /api/security/secret-scan`
- API snapshot, run detail, event filtering, and SSE snapshot payloads are redacted before returning to the dashboard.
- Added deployment commands:
  - `npm run db:migrate`
  - `npm run db:seed`
- Added deployment artifacts:
  - `.dockerignore`
  - `Dockerfile`
  - `docker-compose.yml`
  - `.github/workflows/ci.yml`
- Dockerfile and compose health checks target Fastify `/healthz`.
- README now documents:
  - fresh clone setup;
  - database migration/seed;
  - Agent Ops API/dashboard startup;
  - Docker compose startup;
  - security controls;
  - production secret enforcement;
  - release gates.
- Added deployment readiness eval:
  - checks Docker healthcheck wiring;
  - checks compose API/dashboard services;
  - checks CI gates;
  - checks README startup/security instructions;
  - checks safe `.env.example` and deployment-file secret scan.
- Migration and seed commands were run twice against `/private/tmp` SQLite databases and passed.
- Local health/readiness verification passed on `127.0.0.1:4185`:
  - `/healthz` returned `{ "ok": true }`.
  - `/readyz` returned `{ "ok": true, "database": "connected" }`.
- Docker CLI is installed, but Docker daemon was not running, so the actual container healthcheck could not be executed in this environment:
  - `docker compose build agent-api` failed with daemon connection error.
  - Dockerfile/compose healthcheck wiring is covered by `evals/deployment-readiness.eval.ts`.
- Residual artifact scan passed:
  - `find docs/demo docs/runtime -type f` returned no files.
  - no tracked `.env`, SQLite DB, JSONL runtime logs, screenshots, or stale `dist/scheduler` artifacts were found.
- `npm run check` passed.
- `npm run build` passed.
- `npm run check:package-boundaries` passed.
- `npm run dashboard:build` passed.
- `npm run test` passed: 147 pass, 1 skipped.
- `npm run eval` passed: 11 pass, 1 skipped.
