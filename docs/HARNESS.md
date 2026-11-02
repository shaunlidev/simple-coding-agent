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
- Task runtime tests cover shared SQLite schedules/receipts, due-task selection, feedback replacement, ranking, unique Markdown exports, credentials, worker ownership and atomic legacy imports.
- Task CLI process tests and TUI tests use the same authenticated local host; API integration tests compare task IDs, preferences, feedback and scores before/after restart.
- The opt-in browser eval uses actual Chromium with controlled source/model data through guarded transport and verifies the generated digest.
- TUI tests cover startup, one-shot mode, interactive multi-turn reuse, slash-command resets, streaming text deltas without final duplication, rendered status, tool events, session records, abort, and no-key failure.
- Local evals cover read, edit, path escape rejection, tool-error recovery, and max-turn stop.

## Agent Ops Harness Boundary

The Agent Ops harness must validate production behavior, not generated showcase files. It should read runtime/API/database evidence, reject secret-like values, and produce enough JSON evidence for the dashboard and CI to diagnose failures.

R2 adds real-session auth fixtures, an approval executor with side-effect counters and actual SQLite clearing, network-policy tests at the pipeline boundary, and redaction checks over raw persisted rows and captured logs. `scripts/verify-auth.mjs` operates the built UI at desktop/mobile widths and makes authenticated approval requests through that browser context. `scripts/verify-container.mjs` checks production HTTPS cookie/CSRF behavior in the built image. `evals/browser-security.live.eval.ts` runs actual Chromium against adversarial controlled content and verifies the forbidden destination received zero requests. None of these is evidence of live model quality or cloud readiness.
