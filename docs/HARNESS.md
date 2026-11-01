# Harness

## Harness Standard

Every harness should capture enough data for another agent to diagnose failures without hidden chat context.

Capture:

- input prompt or task fixture;
- provider events;
- agent events;
- transcript/messages;
- tool calls and tool results;
- final output;
- errors;
- usage where available;
- temp workspace path while running and cleanup status after running.

## Planned Harnesses

- `createFauxProviderHarness`: deterministic model responses and provider event traces.
- `createAgentHarness`: temp workspace, faux provider, default tools, transcript, event capture.
- CLI process harness: real process boundary, stdout/stderr/exit code.
- Session JSONL harness: versioned records, append/read order, message replay, and future-version rejection.
- Live DeepSeek harness: opt-in model-backed text smoke plus required-tool-call smoke through the local `read` tool.
- Agent Ops harness: planned runtime/API/dashboard/eval evidence gates over SQLite-backed state.

## Current Harnesses

- `packages/coding-agent/test/process-harness.ts` runs source entries across a real Node process boundary.
- CLI tests cover stdout, stderr, exit codes, session records, resume, and secret redaction failures.
- Browser tool tests cover adapter call order and clear missing-implementation failures.
- Workflow tests cover requirement capture, backlog listing, plan creation, and verification evidence.
- Task runtime tests cover scheduler creation, due-task selection, append-only events, run records, memory preferences, feedback history, ranking, Markdown digest delivery, and browser-source collection through an injected adapter.
- Task CLI tests cover create/list/run/feedback over durable `docs/agent` files.
- The opt-in browser live eval starts a local social-style page, collects it through Playwright, and verifies the generated digest.
- TUI tests cover startup, one-shot mode, interactive multi-turn reuse, slash-command resets, streaming text deltas without final duplication, rendered status, tool events, session records, abort, and no-key failure.
- Local evals cover read, edit, path escape rejection, tool-error recovery, and max-turn stop.

## Agent Ops Harness Boundary

The Agent Ops harness must validate production behavior, not generated showcase files. It should read runtime/API/database evidence, reject secret-like values, and produce enough JSON evidence for the dashboard and CI to diagnose failures.
