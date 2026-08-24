# Architecture

## Package Boundaries

```text
packages/ai
  Provider-neutral model messages, streaming events, EventStream, validators, tool schemas, and providers.

packages/agent
  Agent loop, Agent class, event projection, and tool execution orchestration.

packages/coding-agent
  CLI, default coding tools, JSONL/print modes, session files, and runtime composition.

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
                 -> Tool registry -> local tool result -> next provider turn
```
