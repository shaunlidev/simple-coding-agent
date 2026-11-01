# R1 clean build

Status: final Dockerfile and container verification passed on Linux arm64 on 2026-11-01. R1.1-R1.5 are verified. Commit and remote synchronization are recorded separately below.

## Plan before implementation

Use the accepted R1 scope in [0009](../plans/active/0009-agent-ops-acceptance-recovery.md). Change the root/workspace manifests and lockfile, Node version files, Dockerfile, compose, static dashboard serving, env loading, CI, README, and focused launch tests. Keep later runtime, authorization, scheduling, and memory repairs in their own batches.

Serve the built dashboard from Fastify so UI, API, and SSE share one origin in a container. Keep Vite for local development. Pin Node 22.23.4 for reproducible builds. Add the TypeScript compiler to devDependencies. Use the official full Bookworm Node image for the build stage with its existing compiler toolchain, and the slim image for the non-root runtime stage.

## Acceptance criteria

- R1.1: clean install, check, workspace build, package boundaries, and dashboard build succeed without global tsc.
- R1.2: actual image build succeeds without host node_modules, dist, or secrets.
- R1.3: running container serves health, readiness, dashboard, and snapshot through the same origin. Browser requests succeed.
- R1.4: CLI/TUI help work; an unconfigured real model run fails clearly.
- R1.5: README setup works in a clean environment.

## Baseline

- `797ccb8`: without `/usr/local/bin/tsc` on PATH, `npm run check` exits 127 with `tsc: command not found`.
- The baseline Linux arm64 Docker build exits 1 installing better-sqlite3 because Python is absent.
- Dockerfile omits tsconfig.base.json and omits development build tools by setting NODE_ENV=production before installation.
- The compose dashboard uses localhost API proxying inside its own container.
- The first repaired clean build exposed imports into other packages' pre-existing dist directories. These imports are being migrated to declared workspace package names and source type mappings so check can run before build.

## Verification results

| AC | Current evidence | Status |
| --- | --- | --- |
| R1.1 | Final arm64 build ran npm ci, check, build, package-boundaries, and dashboard build without host node_modules or dist | Passed |
| R1.2 | Final multi-stage arm64 image built successfully, exit 0 | Passed |
| R1.3 | Final container passed Docker health, HTTP readiness, UI and snapshot checks on one origin; no page errors | Passed |
| R1.4 | Container CLI/TUI help and explicit missing-key failure passed; local npm CLI/TUI/task help also passed | Passed |
| R1.5 | Documented clean install, build and startup path reproduced in the final image; help and browser checks passed | Passed |

The arm64 image ID is `sha256:0dcf5c45f8850d8aebedda2f19a2072ce281b6621ba4255ce414eea5361bdb5e`.

The final full-builder build produced the same runtime image ID as the earlier slim-builder build. The compiler stages reran successfully; Docker reused identical runtime layers. Build reference: `desktop-linux/bthu334jb4jvkjsx1323dax5a`. Container verification completed at `2026-11-01T02:02:24.090Z`, exit 0. Evidence: `artifacts/acceptance/R1/arm64/report.json` and `desktop.png`. The temporary verification container was removed.

Local checks on bundled Node 24.19.0 also passed: `npm run check` with `/usr/local/bin` removed from PATH, `npm test`, and `git diff --check`, all exit 0. The supported pinned Node 22.23.4 build was verified inside Docker.

The container checks confirmed a non-root `node` runtime user and the absence of `/app/.env`. A synthetic key was used only to start the container. No live model request was made. This does not close R4 or R10.

The local suite after the workspace import repair passed with 148 passing tests and 1 skipped browser-live test. Both DeepSeek live test functions currently return early without a key; this is not evidence of live model success and remains an R9 reporting repair.

Reproduce container verification with the project's supported Node runtime:

```bash
node scripts/verify-container.mjs simple-coding-agent:r1
```

The verifier starts an isolated container, checks actual Docker health, HTTP endpoints, CLI/TUI behavior, and the browser page, then removes its container. Reports and screenshots are written under `artifacts/acceptance/R1/<architecture>/` and are ignored by git.

Dependency audit output during the Linux build reported advisories. They remain untriaged and are carried into R2. R1 does not claim security or release readiness.

Earlier amd64 attempts failed on intermittent Debian HTTP 502 responses and a certificate post-install `Illegal instruction` under emulation on the ARM Mac. A bounded-retry attempt and a build-only OpenSSL capability experiment did not produce a verified amd64 image. Those checks are failed/cancelled attempts, not passing evidence.

The final design uses the official `node:22.23.4-bookworm` build image, which already includes the compiler toolchain. The project no longer installs that toolchain through apt, and the experimental OpenSSL override has been removed. Runtime remains `node:22.23.4-bookworm-slim`.

Architecture decision on 2026-11-01: stop the optional amd64 emulation build on the ARM Mac. R1 verifies the native Linux arm64 path; it does not claim amd64 support. R10 still requires building and testing the selected cloud architecture, preferably on a native runner. No deployment or cross-architecture requirement is dropped.

## Commit and remote verification

This record is included in the R1 commit. Resolve its exact SHA with `git log --format='%H %s' -- docs/evidence/R1-clean-build.md`. The following batch's evidence records the preceding R1 SHA and the verified remote branch, avoiding a self-referential commit hash.
