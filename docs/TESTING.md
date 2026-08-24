# Testing

## Local Gates

```bash
npm run check
npm run build
npm run check:package-boundaries
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

## Test Layers

- Unit tests cover pure logic and protocol contracts.
- Faux provider tests prove test infrastructure before agent tests depend on it.
- Agent harness tests assert transcripts, event order, tool calls, and final output.
- CLI process tests assert stdout, stderr, and exit codes across the real process boundary.
- Session tests assert JSONL versioning, append/read ordering, replay, and future-version rejection.
- TUI tests assert rendered terminal status, tool events, abort handling, one-shot behavior, interactive multi-turn behavior, slash-command resets, and session records.
- Evals assert task-level behavior and record prompt, transcript, tool events, final output, and workspace path.
