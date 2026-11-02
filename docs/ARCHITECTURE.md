# Architecture

## Package Boundaries

```text
packages/ai
  Provider-neutral model messages, streaming events, EventStream, validators, tool schemas, and providers.

packages/agent
  Agent loop, Agent class, event projection, and tool execution orchestration.

packages/coding-agent
  CLI, default coding tools, browser tools, workflow tools, JSONL/print modes, session files, and runtime composition.

packages/tui
  Interactive terminal UI and one-shot terminal task mode over the coding-agent runtime.
```

## Dependency Direction

```text
ai <- agent <- coding-agent <- tui
```

- `ai` must not import `agent` or `coding-agent`.
- `agent` may import `ai`, but not `coding-agent`.
- `coding-agent` may import both `agent` and `ai`.
- `tui` depends on `coding-agent` runtime composition and does not duplicate provider/tool setup.

## MVP Flow

```text
CLI/TUI -> Agent -> Provider -> EventStream -> Agent events -> CLI/TUI output
                 -> Tool registry -> local/browser/workflow result -> next provider turn
```

## Agent Ops Boundaries

`server` composes authentication, the guarded tool executor and the SQLite runtime. `runtime` depends on `db`, `security`, `agent` and `ai`; it does not depend on the server, dashboard or coding-agent tools. Shared network policy and redaction live in `security`. HTTP/RSS and read-only Chromium collection use the same validated transport. Chromium has a deny-only proxy for unhandled network channels; only the Node transport can make approved source requests. This is not a claim that arbitrary browser scripts or shell execution are safely sandboxed for multi-tenant use.

Content tasks are versioned configuration; admission freezes a task snapshot. The content executor composes the existing Agent with only `collect_source(sourceId)`. Source outcomes and redacted, hashed text are immutable within a run and persisted before tool return. Final output uses exact quotes from those documents; completion rechecks citation membership against actual successful tool results inside the R3 transaction. An RSS article URL is not the feed URL that was read, and page anchors do not become read articles. Citation checks prove provenance, not semantic truth. Production Run now requires a configured task and never falls back to demo; `AGENT_DEMO_MODE=1` is an explicit fixture path.

Persisted runtime events, memory/FTS, content, evaluations and audit records are redacted before insertion. Authentication session data is separate from user-visible business records. Server credentials never enter runtime/model inputs.

## Run Persistence

`runtime` owns request admission and completion. An actor-scoped idempotency key binds a manual request target to one logical run. Reads never admit or execute work. Retries return the original run, including nonterminal or failed states; worker recovery and intentional reruns are separate operations.

Content identity (`content_entities`) is separate from immutable per-run observations (`run_content_results`). `content_deliveries` has a unique workspace/channel/content key, while `run_receipts` preserves even zero-result outcomes. `commitContentRun` owns their single synchronous transaction, including the matching delivery/skip and terminal event. Callers cannot insert content then announce success independently. Demo delivery scope is separate from the workspace inbox. This proves local inbox persistence, not exactly-once external delivery.

Event envelopes/payloads are validated using a single schema registry and stored with an insertion sequence and schema version. Run projection replays that sequence, not wall-clock ordering. Snapshot/run-detail reads use a transaction for their run, event and result view. Result tables are authoritative relational history and are not reconstructible solely from events; backup must include the entire database.

Migrations journal versions/checksums and upgrade the previous unversioned layout transactionally. Legacy surviving results keep their IDs for feedback links; incomplete legacy receipts are explicitly labeled, not invented from old digest text. `db:seed` is the only demo seed command; health/readiness/snapshot do not seed.

## Worker Ownership

`runtime/scheduler.ts` owns all server execution, including manual task runs. Fastify injects the executor and passes authenticated commands; it has no separate active-run map. SQLite `scheduled_jobs` is the dispatch authority, with FIFO sequence, immutable admission target and frozen task snapshot. Admission and automatic cursor advancement share a transaction; claim/start, cancellation intent and terminal completion update job and event records together. The existing result transaction also commits the terminal job state.

`coding-agent/tasks.ts` is a terminal adapter over `runtime/local-host.ts`.
The local host authenticates an environment-supplied identity using the shared
security module before opening the database. Both server and terminal compose
`createContentExecutor` and `RuntimeScheduler`; there is no second terminal
collector, scorer or JSON scheduler. `coding-agent` therefore also depends on
`runtime`; the runtime never imports terminal/server/UI packages. Terminal digests
are exports. Explicit legacy import records a manifest and paused configuration
transactionally, preserving old files without promoting unbound legacy feedback.

One process holds an exclusive transaction on a separate, canonical-path sibling SQLite lock database. The business database remains available for ordinary reads/writes. Ownership is cooperative and restricted to one host with local persistent storage; no expiring lease permits a second process to take over a hung owner. Graceful shutdown drains before releasing the lock; process death releases it through OS locking. Restart fails interrupted attempts and retains unstarted work. Heartbeat will report health in R7, not grant ownership.

`schedule-time.ts` uses pinned cron-parser plus node-cron validation. A timezone-explicit node-cron poll wakes reconciliation; the persisted due cursor decides admission. Intervals retain phase, cron/DST behavior is pinned by tests, and missed ranges coalesce without unbounded enumeration. Cancellation commits a write fence before aborting the executor. A replacement cannot start until the old execution settles; already-sent remote requests cannot be undone.
