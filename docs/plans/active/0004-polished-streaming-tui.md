# Polished Streaming TUI Plan

## Goal

Move the TUI from a plain log-style REPL to a readable agent interface with streaming assistant output.

## References

- Codex-style interactive mode: user messages, agent messages, command/tool execution, and file changes should be visible in the main conversation view.
- Codex/Gemini-style event lifecycle: start, delta, completion should be separate so output can stream before the final message.
- Claude Code-style terminal UX: avoid unnecessary flicker and keep long-running work visibly alive.
- Pi-style architecture: keep the UI thin and leave session/runtime behavior in the agent layer.

## Implemented Scope

- Agent-style turn layout using `You`, `Agent`, `Tools`, and `status` blocks.
- Compact header with cwd, model, thinking, and session state.
- Tool start/end rendering with status markers and compact argument/result summaries.
- Provider `text_delta` streaming to stdout as chunks arrive.
- Final assistant fallback only when no text deltas were streamed.
- No duplicate final text after streaming.
- ANSI colors when stdout is a TTY, with readable plain output for pipes/tests.

## Acceptance Criteria

- One-shot TUI still works with `npm run tui -- "prompt"`.
- Interactive TUI still works with `npm run tui`.
- Assistant text is rendered from provider text deltas before final completion.
- Final assistant text is not printed a second time after streaming.
- Tool calls are visibly separated from assistant text.
- Tests cover streaming order and no-duplicate behavior.
- Local gates and live DeepSeek smoke pass.

## Deferred

- Full-screen alternate buffer.
- Scrollback/search mode.
- Collapsible tool cards.
- Inline diff rendering.
- Mouse support.
