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

`server` composes authentication, the guarded tool executor and the SQLite runtime. `runtime` depends on `db` and `security`; it does not depend on the server or dashboard. Shared network policy and redaction live in `security`. HTTP/RSS and read-only Chromium collection use the same validated transport. Chromium has a deny-only proxy for unhandled network channels; only the Node transport can make approved source requests. This is not a claim that arbitrary browser scripts or shell execution are safely sandboxed for multi-tenant use.

Persisted runtime events, memory/FTS, content, evaluations and audit records are redacted before insertion. Authentication session data is separate from user-visible business records. Server credentials never enter runtime/model inputs.

## Run Persistence

`runtime` owns request admission and completion. An actor-scoped idempotency key binds a manual request target to one logical run. Reads never admit or execute work. Retries return the original run, including nonterminal or failed states; worker recovery and intentional reruns are separate operations.

Content identity (`content_entities`) is separate from immutable per-run observations (`run_content_results`). `content_deliveries` has a unique workspace/channel/content key, while `run_receipts` preserves even zero-result outcomes. `commitContentRun` owns their single synchronous transaction, including the matching delivery/skip and terminal event. Callers cannot insert content then announce success independently. Demo delivery scope is separate from the workspace inbox. This proves local inbox persistence, not exactly-once external delivery.

Event envelopes/payloads are validated using a single schema registry and stored with an insertion sequence and schema version. Run projection replays that sequence, not wall-clock ordering. Snapshot/run-detail reads use a transaction for their run, event and result view. Result tables are authoritative relational history and are not reconstructible solely from events; backup must include the entire database.

Migrations journal versions/checksums and upgrade the previous unversioned layout transactionally. Legacy surviving results keep their IDs for feedback links; incomplete legacy receipts are explicitly labeled, not invented from old digest text. `db:seed` is the only demo seed command; health/readiness/snapshot do not seed.
