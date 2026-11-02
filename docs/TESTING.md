# Testing

## Local Gates

```bash
npm run check
npm run build
npm run check:package-boundaries
npm run dashboard:build
npm run test
npm run eval
```

These commands must not require network or a real API key.

The test runner executes `.ts` test files directly with Node's experimental type transform. Build-style `.js` imports remain in production TypeScript sources, so tiny source shims may exist beside selected `.ts` files when a direct source test needs Node to resolve that import without a compiled `dist` tree.

## Live DeepSeek Gate

```bash
DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-v4-pro npm run test:live
```

Live tests are opt-in and should not run in default CI.
Without `DEEPSEEK_API_KEY`, the live smoke test exits quickly without making a network request.
With a key, the live gate verifies both plain text completion and a required tool-call path against a temporary fixture file.

## Live Browser Scenario

```bash
RUN_BROWSER_LIVE=1 npm run test:live
```

The opt-in browser eval uses actual Chromium, the shared terminal/runtime path
and guarded transport against controlled HTML. The model is controlled too;
this proves browser/task integration, not public-source or live-model quality.

## R2 Security Acceptance

After `npm run build` and `npm run dashboard:build`:

```bash
node scripts/verify-auth.mjs
RUN_BROWSER_LIVE=1 node --experimental-transform-types --test evals/browser-security.live.eval.ts
docker build --platform linux/arm64 -t simple-coding-agent:r2 .
node scripts/verify-container.mjs simple-coding-agent:r2
npm audit --omit=dev --registry=https://registry.npmjs.org
```

These use isolated SQLite, synthetic secrets and actual Chromium. The browser security eval uses controlled HTML/transport and a real forbidden local HTTP/WebSocket listener, not a public content or live model success. The container gate uses an ephemeral self-signed HTTPS fixture and checks production cookies. It removes its container and temporary certificate afterward. Reports/screenshots are under `artifacts/acceptance/R2/`. Linux arm64 was tested; other deployment architectures need R10 validation. The production audit currently has three moderate affected packages; see the bounded exposure analysis in R2 evidence, not an assumed clean result.

## Coverage

R6 after building API and Dashboard:

```bash
node scripts/verify-memory-ui.mjs
node scripts/verify-memory-process.mjs
```

The browser gate operates feedback, preference history, knowledge retrieval,
practice review/eval/activation/rollback, export and approved clear at desktop/
mobile widths. Provider/source responses are controlled; lost responses are
injected after the real feedback commit to verify retry idempotency. The process
gate stops/restarts the actual API and executes the same SQLite task from a
separate authenticated CLI process. Reports under `artifacts/acceptance/R6/`
record SHA/dirty state. Neither gate proves live-model quality or deployment.

R5 after building API and Dashboard:

```bash
node --experimental-transform-types --test packages/runtime/test/schedule-time.test.ts packages/runtime/test/scheduler.test.ts packages/server/test/scheduler.test.ts
node scripts/verify-scheduler-process.mjs
node scripts/verify-scheduler-ui.mjs
```

The process gate launches separate actual workers, refuses a second owner, SIGKILLs the first and verifies frozen queued work/FIFO/nextRunAt after restart. Provider and source responses are controlled. The UI gate creates a schedule, begins an actual Chromium source read, cancels it, asserts transport abort/no delivery, and pauses/resumes at desktop/mobile widths. Evidence under `artifacts/acceptance/R5/` records SHA/dirty state; this is not cloud or live-model evidence. The cancelled request's remote service may already have done work; tests prove local abort, no subsequent dispatch and no local delivery.

R4 after building:

```bash
node scripts/verify-content-agent.mjs
RUN_DEEPSEEK_LIVE=1 node --env-file-if-exists=.env scripts/verify-content-live.mjs
```

The first gate uses controlled provider/transport responses but the actual Dashboard/API/SQLite and Chromium source adapter. The second uses real DeepSeek, public RSS and Chromium; it is bounded to three provider turns and returns exit 2 (not success) when credentials/opt-in are absent. Set `AGENT_DNS_MODE=cloudflare` explicitly only when the system resolver produces fake/private source addresses; the first failed attempt remains evidence. Reports under `artifacts/acceptance/R4/` distinguish fixture/live runs and record SHA plus dirty state. Exact citation checks prove textual provenance, not semantic entailment.

R3 consistency verification after building the API and dashboard:

```bash
node --experimental-transform-types --test packages/db/test/migrations.test.ts packages/runtime/test/consistency.test.ts packages/server/test/consistency.test.ts
node scripts/verify-consistency.mjs
```

The script starts the actual API entry in a child process against an isolated file database, performs three UI runs, selects historical results, checks mobile overflow, stops/restarts the child and compares the persisted result. It then checks raw result/delivery/event counts. It uses the explicitly labeled demo executor with no provider key. Reports/screenshots are under `artifacts/acceptance/R3/`; temporary databases and processes are cleaned up. Tests inject a failing SQLite trigger to prove rollback and import fixtures from both baseline schema variants. Old unsupported/corrupt schemas must fail instead of silently resetting data.

- Unit tests cover pure logic and protocol contracts.
- Faux provider tests prove test infrastructure before agent tests depend on it.
- Agent harness tests assert transcripts, event order, tool calls, and final output.
- CLI process tests assert stdout, stderr, and exit codes across the real process boundary.
- Session tests assert JSONL versioning, append/read ordering, replay, and future-version rejection.
- Browser tool tests use fake adapters so local gates do not require browser installation.
- Workflow tests assert durable files under `docs/agent/`.
- Task runtime tests assert shared SQLite jobs/events/receipts, preferences, feedback replacement, ranking, per-run digest exports, guarded source collection, ownership conflicts and atomic/idempotent legacy import.
- Agent Ops runtime tests assert event replay, malformed event rejection, schedule actions, content feedback, guarded memory writes, and security audit behavior.
- Dashboard evals assert build output, operations cockpit content, API wiring, and absence of `docs/demo` dependencies.
- TUI tests assert rendered terminal status, streaming text deltas, no final text duplication after streaming, tool events, abort handling, one-shot behavior, interactive multi-turn behavior, slash-command resets, and session records.
- Evals assert task-level behavior and record prompt, transcript, tool events, final output, and workspace path.
