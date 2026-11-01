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
