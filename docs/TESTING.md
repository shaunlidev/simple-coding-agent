# Testing

## Local Gates

```bash
npm run check
npm run build
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

## Test Layers

- Unit tests cover pure logic and protocol contracts.
- Faux provider tests prove test infrastructure before agent tests depend on it.
- Agent harness tests assert transcripts, event order, tool calls, and final output.
- CLI process tests assert stdout, stderr, and exit codes across the real process boundary.
- Evals assert task-level behavior and keep replayable artifacts.
