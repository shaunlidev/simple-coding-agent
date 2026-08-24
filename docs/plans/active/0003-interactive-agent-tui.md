# Interactive Agent TUI Plan

## Goal

Make `npm run tui` start a usable local interactive agent session. The user should be able to chat with the agent in a terminal, see tool activity, keep session records, and exit cleanly.

This extends the existing one-shot TUI instead of replacing it:

- `npm run tui` starts interactive mode.
- `npm run tui -- "prompt"` keeps the current one-shot task mode.

## Pi-Inspired Practices

Pi keeps the core agent runtime separate from its terminal UI. Its interactive mode is the default human workflow, while print, JSON, RPC, and SDK modes serve automation and embedding. This project should follow the same shape at a smaller scale:

- Keep the TUI as a thin layer over the existing agent runtime.
- Preserve one-shot mode for scripts and smoke tests.
- Make interactive state explicit: cwd, model, thinking, session path, and current turn.
- Render tool calls as first-class events, not hidden logs.
- Make cancellation, errors, and session persistence harnessable from tests.

## Phase 1: Mode Split

### Implementation

- Change TUI argument parsing so an empty prompt means interactive mode.
- Keep `--help`, `--version`, and one-shot prompt behavior unchanged.
- Keep existing flags available in both modes:
  - `--cwd PATH`
  - `--model MODEL`
  - `--thinking`
  - `--session PATH`

### Acceptance Criteria

- `parseTuiArgs([])` returns an interactive command.
- `npm run tui -- --help` does not require `DEEPSEEK_API_KEY`.
- `npm run tui -- "Reply exactly ok"` still runs one-shot mode.

## Phase 2: REPL Interaction

### Implementation

- Start a terminal prompt loop with a compact header.
- Submit each non-empty line as a user prompt.
- Reuse the same runner across turns so conversation context persists.
- Support slash commands:
  - `/help`
  - `/quit`
  - `/exit`
  - `/clear`
  - `/cwd PATH`
  - `/model MODEL`
  - `/thinking on|off`
  - `/session PATH`

### Acceptance Criteria

- Two prompts in one interactive session call the same runner twice.
- `/clear` resets conversation state and creates a new runner on the next prompt.
- `/cwd`, `/model`, and `/thinking` reset the runner before the next prompt.
- `/quit` and `/exit` return exit code `0`.

## Phase 3: Agent Feedback

### Implementation

- Show current cwd, model, thinking state, and session path at startup.
- Show `turn N` before each prompt run.
- Render tool start/end events during a run.
- Render final assistant text after the run completes.
- Render error and aborted states distinctly.
- Avoid printing `status: done` from a raw `agent_end` event, because `agent_end` also happens for errors and aborts.

### Acceptance Criteria

- Tool start/end events appear in stdout in order.
- Successful turns print `status: done`.
- Error turns print `status: error` and stderr includes the error message.
- Aborted turns print `status: aborted`.

## Phase 4: Session Persistence

### Implementation

- Append a versioned user message for every submitted prompt.
- Append every agent event.
- Append the final assistant message for every turn.
- Continue rejecting records that would include `DEEPSEEK_API_KEY`.

### Acceptance Criteria

- A two-turn interactive test records both user messages and both assistant messages.
- Session records remain version `1`.
- Session output does not contain the real DeepSeek key.

## Phase 5: Harness And Manual Acceptance

### Implementation

- Add deterministic tests with fake input and fake runtime.
- Keep local gates network-free.
- Keep live DeepSeek smoke opt-in.

### Acceptance Criteria

- `npm run check`
- `npm run build`
- `npm run check:package-boundaries`
- `npm run test`
- `npm run eval`
- With `DEEPSEEK_API_KEY`: `npm run tui`, enter `Reply exactly ok`, receive `ok`, then `/quit`.

## Out Of Scope For This Pass

- Full-screen terminal component framework.
- Autocomplete.
- Session tree branching.
- Extension/package system.
- RPC mode.
- Inline diff renderer.
