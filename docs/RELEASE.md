# Release Checklist

The project is GitHub-only until npm publishing is explicitly enabled.

Before sharing a release candidate:

- Confirm `README.md` quickstart matches the current CLI and TUI behavior.
- Run `npm run check`.
- Run `npm run build`.
- Run `npm run check:package-boundaries`.
- Run `npm run test`.
- Run `npm run eval`.
- Run `npm run test:live` without `DEEPSEEK_API_KEY` and confirm it skips model calls.
- Run `DEEPSEEK_API_KEY=... npm run test:live` before a model-backed release.
- Confirm `.env` is ignored and `.env.example` is tracked.
- Confirm no committed file contains a real API key.
- Confirm package manifests still say `private: true` unless npm publishing is intended.

If npm publishing is later enabled:

- Add a license.
- Add package `exports`.
- Add package `files` allowlists.
- Remove `private: true` only for intended public packages.
- Add a changelog entry.
- Tag the release commit.
