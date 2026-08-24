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

## Current Harnesses

- `packages/coding-agent/test/process-harness.ts` runs source entries across a real Node process boundary.
- CLI tests cover stdout, stderr, exit codes, session records, resume, and secret redaction failures.
- TUI tests cover startup, one-shot mode, interactive multi-turn reuse, slash-command resets, streaming text deltas without final duplication, rendered status, tool events, session records, abort, and no-key failure.
- Local evals cover read, edit, path escape rejection, tool-error recovery, and max-turn stop.
