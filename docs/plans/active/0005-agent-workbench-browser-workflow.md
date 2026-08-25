# Agent Workbench Browser Workflow Plan

## Goal

Build the first usable slice of an agent workbench: a clearer agent-style terminal surface, browser-oriented tool calling, and a local workflow system for collecting requirements, ranking work, producing plans, and recording verification evidence.

After this change a developer can:

- Start `npm run tui` and see an agent workbench header with mode, model, cwd, session, and workflow hints.
- Ask the agent to use browser tools when Playwright is available locally.
- Use workflow tools or TUI slash commands to capture requirements, list backlog, create an implementation plan, and record verification evidence.
- Verify the behavior through deterministic tests that do not require a browser install or network.

## Context

The repository is a TypeScript monorepo:

- `packages/ai` defines provider-neutral stream events and tool schemas.
- `packages/agent` runs the model/tool loop.
- `packages/coding-agent` composes the DeepSeek provider with local tools.
- `packages/tui` renders the terminal UI over the coding-agent runtime.

The current TUI is an interactive streaming REPL. It has readable `You`, `Agent`, `Tools`, and `status` blocks, but it does not yet expose workflow commands or browser-specific tools.

## Design

### TUI

Keep the current plain terminal renderer rather than adding a new dependency. Improve the surface so it resembles mainstream coding-agent TUIs:

- Workbench-style header.
- Mode and workflow hints.
- Tool calls visible in the `Tools` block.
- Slash commands for `/spec`, `/backlog`, `/plan`, and `/verify`.

This gives most of the user-visible shape without taking on a full-screen framework in this pass.

### Browser Tools

Expose MCP-inspired browser tools:

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_close`

The default implementation dynamically loads `playwright` if it is installed. Tests use an injected fake browser adapter, so local gates do not require downloading browsers.

The default browser session is isolated and headless unless the tool input asks otherwise. If Playwright is not installed, the tools fail clearly with installation guidance.

### Workflow Tools

Create a local workflow store under `docs/agent/`:

- `docs/agent/inbox.json`
- `docs/agent/backlog.json`
- `docs/agent/specs/*.md`
- `docs/agent/plans/active/*.md`
- `docs/agent/evidence/*.md`

Expose tools:

- `workflow_capture_requirement`
- `workflow_list_backlog`
- `workflow_create_plan`
- `workflow_record_verification`

The tools are intentionally boring JSON/Markdown writers. They keep workflow state in the repository so another agent can resume from files instead of hidden chat context.

## Acceptance Criteria

- Browser tool tests prove navigate, snapshot, click, type, and close call an injected adapter in order.
- Browser tools fail clearly when no Playwright implementation is available.
- Workflow tests prove requirement capture writes inbox/backlog/spec files.
- Workflow tests prove plan creation writes a self-contained active plan with acceptance criteria.
- Workflow tests prove verification evidence is written to `docs/agent/evidence`.
- TUI tests prove `/spec`, `/backlog`, `/plan`, and `/verify` commands produce workflow artifacts or output.
- TUI help lists the workflow commands.
- Local gates pass:
  - `npm run check`
  - `npm run build`
  - `npm run check:package-boundaries`
  - `npm run test`
  - `npm run eval`

## Deferred

- Full-screen alternate screen rendering.
- Scrollback and fixed bottom input.
- Rich diff cards.
- MCP client support.
- Persistent headed browser state.
- Automatic issue prioritization from GitHub.
- Blocking completion hooks.
