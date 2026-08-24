# Local Usable Secure TUI Plan

## Goal

Turn the current CLI MVP into a project that another developer can clone, configure, run locally, and trust with a DeepSeek key. Then add a minimal TUI on top of the same agent runtime.

This plan follows practices common in mature coding-agent projects:

- Keep CLI, TUI, agent loop, provider, and tools separated by package boundaries.
- Make secrets explicit environment configuration, never committed files or session records.
- Treat tool execution as the highest-risk surface and test it with adversarial fixtures.
- Prefer deterministic local tests, with opt-in live model tests.
- Ship a boring, copy-pasteable quickstart before adding richer UI.
- Make every acceptance gate runnable by another agent without hidden chat context.

## Current State

- `packages/coding-agent` is a runnable CLI after `npm run build`.
- `packages/tui` is a minimal terminal task UI after `npm run build`.
- DeepSeek key is read from `DEEPSEEK_API_KEY`.
- Session JSONL exists, and CLI exposes `--session` and `--resume`.
- Local tools enforce filesystem root boundaries, including write symlink parent checks.
- `bash` runs with a scrubbed environment by default.
- README quickstart, `.env.example`, and a GitHub-only release checklist exist.

## Implementation Status

- [x] Phase 1: Secret and tool hardening
- [x] Phase 2: Local quickstart and developer UX
- [x] Phase 3: Session CLI surface
- [x] Phase 4: Minimal TUI
- [x] Phase 5: Packaging readiness
- [x] Phase 6: Stronger harnesses

## Phase 1: Secret And Tool Hardening

### Implementation

- Add `.env` and `.env.*` to `.gitignore`, while allowing `.env.example`.
- Add `.env.example` with placeholder `DEEPSEEK_API_KEY=` and optional `DEEPSEEK_MODEL=`.
- Change `bashTool` to run with a scrubbed environment by default.
- Remove high-risk variables from spawned commands, at minimum:
  - `DEEPSEEK_API_KEY`
  - variables ending in `_API_KEY`
  - variables ending in `_TOKEN`
  - variables ending in `_SECRET`
  - `OPENAI_API_KEY`
  - common cloud credential variables
- Keep a small safe baseline environment for PATH/HOME/TMPDIR if needed for local commands.
- Document that tools can read and modify only `--cwd`/current working directory.

### Acceptance Criteria

- A test proves `bashTool({ command: process.execPath, args: [...] })` cannot read `DEEPSEEK_API_KEY`.
- A test proves ordinary shell execution still works after env scrubbing.
- A test proves `.env` is ignored but `.env.example` is tracked.
- No test, JSONL session, CLI output, or error output includes a real API key.
- `npm run check`, `npm run build`, and `npm run test` pass.

## Phase 2: Local Quickstart And Developer UX

### Implementation

- Add `README.md` with:
  - project status: CLI MVP, TUI pending;
  - prerequisites;
  - clone/install/build steps;
  - DeepSeek configuration;
  - `--print`, `--json`, `--cwd`, `--model`, `--thinking` examples;
  - local safety notes;
  - test/eval commands.
- Add a root script for local CLI execution, for example `npm run agent -- --print "..."`.
- Add a no-key smoke command that verifies CLI help/version without network.
- Add troubleshooting notes for missing key, missing build, and unsupported Node versions.

### Acceptance Criteria

- A fresh developer can run the README quickstart from a clean clone.
- `npm run agent -- --help` works without `DEEPSEEK_API_KEY`.
- `npm run agent -- --print "hello"` fails clearly without `DEEPSEEK_API_KEY`.
- With `DEEPSEEK_API_KEY`, `npm run agent -- --print "Reply exactly ok"` returns an assistant response.
- Documentation states that the project is not yet a published npm package.

## Phase 3: Session CLI Surface

### Implementation

- Add CLI flags:
  - `--session PATH` to append versioned JSONL records.
  - `--resume PATH` to replay prior messages before a new prompt.
- Write session records for user prompts, agent events, and final messages.
- Reject unsupported future session versions before running the model.
- Keep session format stable and documented.

### Acceptance Criteria

- CLI process test proves `--session` creates JSONL records with `version: 1`.
- CLI process test proves `--resume` replays prior messages into the agent runtime.
- CLI process test proves future-version session files fail before provider initialization.
- Session files never include `DEEPSEEK_API_KEY`.
- `npm run test` covers append, replay, and failure paths.

## Phase 4: Minimal TUI

### Implementation

- Build `packages/tui` as a thin UI over the existing `Agent`.
- Reuse `coding-agent` runtime composition instead of duplicating provider/tool setup.
- First screen should be the working chat/task interface, not a landing page.
- Show:
  - prompt input;
  - streaming assistant text;
  - tool call start/end status;
  - error/abort state;
  - current working directory;
  - model name.
- Support:
  - submit prompt;
  - cancel current run;
  - quit;
  - optional session path.
- Keep TUI local-only; no network other than DeepSeek provider calls.

### Acceptance Criteria

- TUI can run locally after `npm run build`.
- TUI help/static startup does not require an API key.
- TUI run mode fails clearly without `DEEPSEEK_API_KEY`.
- With a key, a smoke task streams text and displays tool-call status.
- Abort test proves cancel returns `stopReason: "aborted"`.
- TUI uses the same local tool safety boundary as CLI.

## Phase 5: Packaging Readiness

### Implementation

- Decide whether to publish as npm packages or keep GitHub-only for now.
- If publishing:
  - remove package-level `private: true` only when ready;
  - add package exports;
  - add files allowlist;
  - add license;
  - add changelog.
- If GitHub-only:
  - document `npm install`, `npm run build`, and direct `node dist/entry.js` usage.
- Add a release checklist.

### Acceptance Criteria

- A clean clone can build and run without relying on generated local-only state.
- Package boundary check confirms built runtime files do not import `src`.
- README accurately says whether npm publishing is supported.
- Release checklist includes check/build/test/eval/live-gate steps.

## Phase 6: Stronger Harnesses

### Implementation

- Add a reusable CLI process harness utility for tests.
- Add redaction tests around event JSONL, session JSONL, stdout, and stderr.
- Add a small eval set for:
  - read file and answer;
  - edit file with exact expected diff;
  - reject path escape;
  - handle tool error and recover;
  - stop on max turns.
- Keep live DeepSeek eval opt-in and small.

### Acceptance Criteria

- Local evals are deterministic and require no network.
- Live evals skip without key and run with key.
- Every eval records prompt, transcript, tool events, final output, and workspace path.
- Failures are diagnosable from captured artifacts, not chat context.

## Suggested Order

1. Phase 1, because key leakage through `bash` is the highest-risk issue.
2. Phase 2, because other people cannot reliably use the project without docs and scripts.
3. Phase 3, because session/resume is core agent UX and already partly implemented.
4. Phase 4, because TUI should sit on hardened, documented runtime behavior.
5. Phase 5, because packaging should happen after the local UX is stable.
6. Phase 6, then continue expanding eval coverage as features grow.

## Definition Of Done

The project is locally usable by another developer when:

- README quickstart succeeds from a clean clone.
- No real key is committed, logged, serialized, or exposed to default tool subprocesses.
- CLI can run real DeepSeek tasks with local file tools.
- TUI can run the same runtime for basic prompt/tool workflows.
- Check/build/test/eval gates pass locally.
- Live DeepSeek smoke passes when `DEEPSEEK_API_KEY` is provided and skips without it.
