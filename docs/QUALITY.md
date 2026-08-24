# Quality

## Current Gates

- TypeScript strict mode.
- Build emits only package `src` output.
- EventStream behavior is covered by deterministic tests.

## Known Gaps

- Dependency-direction check script is not implemented yet.
- Public entry import smoke test is not implemented yet.
- JSONL schema tests will be added with JSON mode.
- Stdout cleanliness tests will be added with CLI modes.
- DeepSeek live tests will be added after the provider exists.

## Rule

When a bug is found, add or update a regression test unless the reason not to is written here.
