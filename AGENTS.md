# Agent Map

This repository is built for agent-first development. Keep this file short and use it as a map.

- Read `docs/ARCHITECTURE.md` before changing package boundaries.
- Read `docs/TESTING.md` before adding or changing behavior.
- Read `docs/HARNESS.md` before changing tests, evals, event streams, providers, tools, or CLI modes.
- Track active work in `docs/plans/active/`.
- Move completed plans to `docs/plans/completed/`.
- Record quality gaps and missing harness coverage in `docs/QUALITY.md`.

Core dependency direction:

```text
ai <- agent <- coding-agent
```

Do not introduce imports in the opposite direction.
