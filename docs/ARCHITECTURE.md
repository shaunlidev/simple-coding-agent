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
  Reserved for future terminal UI work.
```

## Dependency Direction

```text
ai <- agent <- coding-agent
```

- `ai` must not import `agent` or `coding-agent`.
- `agent` may import `ai`, but not `coding-agent`.
- `coding-agent` may import both `agent` and `ai`.
- `tui` is isolated until interactive UI work begins.

## MVP Flow

```text
CLI -> Agent -> Provider -> EventStream -> Agent events -> CLI output
             -> Tool registry -> local tool result -> next provider turn
```
