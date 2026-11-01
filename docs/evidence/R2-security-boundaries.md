# R2 security boundaries

Status: R2 behavioral gates passed on 2026-11-01; commit/push checkpoint follows. No deployment approval.

## Prerequisite

R1 passed on Linux arm64 and was committed as `98501c5a9a84ede276bc4d6d8c6d841294c3235b`. `git ls-remote origin refs/heads/fix/agent-ops-acceptance` returned that exact SHA on 2026-11-01. Main is unchanged. AMD64 remains a selected-target validation in R10.

## Scope and implementation order

1. Update audited Fastify/static/Zod dependencies and lockfile, retaining the accepted stack. Use maintained Fastify cookie/session/rate-limit plugins. Record the official-registry audit result, not a mirror's empty response.
2. Add server-side sessions backed by SQLite. Operator/viewer identities come from server-only configuration, never a caller-supplied role. Regenerate sessions on login, expire and revoke them on logout. HttpOnly, SameSite and production Secure cookies; session-bound CSRF tokens on writes. Public endpoints are limited to login, static UI and minimal health/readiness. Apply request size and login/run rate limits.
3. Add approval records binding the run, registered tool, canonical argument hash, actor, expiry and consumption. Atomically consume the server record before the bound executor runs. Unknown tools and forged client trust/approval attributes fail closed. Cloud execution does not register bash or arbitrary filesystem writes.
4. Add a shared network policy at the real content-fetch boundary. Allow exact origins, reject credentials/non-HTTP protocols, private/reserved IPs and unsafe redirects. Resolve and pin validated addresses in the transport to avoid DNS rebinding. Bound response bytes, redirects and time. Browser subrequests must use the same boundary, with service workers and unsupported network channels disabled; a preflight check alone is insufficient.
5. Redact configured secrets and structured secret fields before persistence and logging. Record actor/action/decision/correlation IDs in security audit events. API serialization is a final defense, not the only redaction point.
6. Provide a minimal login path so the existing dashboard remains usable under authentication. Full dashboard workflows remain R8. Update environment examples and verifier without modifying the user's existing `.env`.

Files: `packages/security`, `packages/server`, narrowly scoped `packages/db` auth/approval schema and `packages/runtime` persistence/network integration; dashboard authentication entry only; focused tests/evals, `.env.example`, README, lockfile and container verifier. No scheduler, ranking or telemetry feature work in this batch.

## Acceptance matrix

| AC | Required behavioral evidence | State |
| --- | --- | --- |
| R2.1 | Anonymous API/SSE/export 401, viewer mutations/execution/approval 403, operator succeeds with valid CSRF; expiry/logout fail closed | Passed API, desktop/mobile and production HTTPS container checks |
| R2.2 | Forged approved, sourceTrust, approver and foreign run binding cannot authorize execution | Focused regression passed |
| R2.3 | Actual executor not called without matching unexpired unconsumed approval; approved operation executes exactly once | Executor concurrency/expiry/binding and real SQLite memory-clear checks passed |
| R2.4 | Actual URL/RSS/browser boundary blocks off-list, private addresses, redirect and subrequest violations before destination request; pinning and byte/time limits tested | Passed unit, pipeline and actual Chromium adversarial checks |
| R2.5 | Synthetic secrets absent from SQLite events/memory/audit, captured logs, export, API/SSE and UI; audit has identity and correlation | Passed raw SQLite/FTS, logs, API/SSE/trace/export and desktop/mobile UI checks |

Reproduce the baseline using Fastify inject against an isolated SQLite database: anonymous snapshot/export/write currently return 200; `approved:true` authorizes `browser_click`; client `sourceTrust:system` is accepted; direct pipeline fetch bypasses the allowlist. Regression tests must demonstrate those failures before relying on fixes.

Automatic gates: focused auth, approval, network and persistence tests, then check/build/boundaries/dashboard/test/eval. Manual-equivalent browser flow: anonymous access, viewer login and denied Run now, operator login, single-use approval, logout. Use isolated test credentials only. Do not use real DeepSeek calls for security gates.

## Implementation references

- [Fastify cookie](https://github.com/fastify/fastify-cookie): cookie hooks, supported Fastify versions and flags.
- [Fastify session](https://github.com/fastify/session): server-side session lifecycle and custom store interface.
- [Fastify rate limit](https://github.com/fastify/fastify-rate-limit): request limits and route overrides.
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html): allowlisting, redirect validation and DNS pinning risks.
- [Node HTTP request](https://nodejs.org/docs/latest-v22.x/api/http.html#httprequestoptions-callback): custom lookup for the actual connection, abort and timeout handling.

## Evidence and remaining work

Baseline failures captured before fixes: anonymous snapshot was 200 instead of 401; forged `approved:true` was 200 instead of 400. Login did not exist (404). New regression cases now reject these requests.

Current implementation uses @fastify/cookie 11.x, @fastify/session 11.1.6 and its atomic compare-and-set store contract, @fastify/rate-limit 10.x, Fastify 5.12.7, @fastify/static 10.1.8 and Zod 4.6.7. Exact versions are in the lockfile. The handwritten Node API shims were removed and replaced with explicit @types/node 22.20.5 so crypto/session code is checked against real APIs. No user's `.env` was modified.

Authentication evidence: `scripts/verify-auth.mjs` completed on 2026-11-01 at `02:12:30Z` with exit 0. It used isolated in-memory SQLite, synthetic credentials, actual Chromium and the built dashboard at widths 1440 and 390. It confirmed login, operator access, viewer denial, logout revocation, no page-level horizontal overflow and no JavaScript page errors. Reports and six screenshots are under `artifacts/acceptance/R2/auth/`. This was demo execution, not a live model test. The browser and server were closed afterward.

Focused server tests currently pass 19 cases including persistent sessions across restart, expiry, Secure cookie, login rate limit, request size, forged trust/approval fields, concurrent approval reuse and actual memory clearing. The wider suite after the approval changes passed 158 with one browser-live skip; check and package-boundaries also passed. Final R2 acceptance still requires a rerun after the remaining changes. The same prior caveat about DeepSeek tests returning early without a key still applies.

The final policy cleanup removed the boolean approval argument from `evaluateToolCall` entirely. High-risk policy checks cannot grant execution; only the bound executor consumes stored approvals. Build and the combined security/server suite (23 cases) passed after this cleanup, with exit 0.

Official-registry production audit after the updates reports zero high/critical advisories and three moderate affected packages: @fastify/static, glob, minimatch. The suggested downgrade to static 6 is incompatible with the accepted Fastify 5 stack and was not applied. Remaining exposure and compatible remediation need explicit triage before R2 closure. This is not a zero-vulnerability claim.

## Final gate evidence

- `npm run check`, `npm run build`, `npm run check:package-boundaries`, and dashboard build passed. The native image build also reran compiler/build/boundary gates in the pinned Node 22.23.4 environment.
- Full `npm test`: 168 total, 166 reported pass, 2 explicit browser skips, zero failures. Two of the reported passes are legacy keyless DeepSeek early returns, NOT exercised live calls; honest skip reporting remains R9. `npm run eval`: 11 reported pass, 2 skips, same DeepSeek caveat. No user's `.env` was loaded.
- `packages/security/test/network.test.ts` (4), runtime network-boundary tests (2), auth tests (8), executor tests (2), redaction tests (2), plus existing API regressions passed. The final API rerun also verifies post-start wildcard assets and encoded traversal rejection.
- `RUN_BROWSER_LIVE=1 node --experimental-transform-types --test evals/browser-security.live.eval.ts`: 1 pass, no skips. Actual Chromium executed dynamic adversarial HTML. A real forbidden loopback HTTP/WebSocket listener received zero requests. Off-list, non-GET and private redirect requests were blocked. This is controlled-content browser evidence, not real-public-source or model evidence.
- `node scripts/verify-auth.mjs`: actual UI at 1440 and 390 widths; login, operator/viewer, logout, no horizontal overflow/page errors and secret absence passed. The final script additionally requests and approves an operation through the authenticated browser context, executes it once and rejects reuse. Full approval UI remains R8.
- `node scripts/verify-container.mjs simple-coding-agent:r2`: passed on arm64 at `2026-11-01T02:36:20.024Z`; image `sha256:687f6d1a504bf6f56b2adca9a2396c2df5bb441f549480a4a8d880fe33fd541a`. Non-root, no `.env`, CLI/TUI help and missing-key failure; real HTTPS login, Secure/HttpOnly/SameSite `__Host-` cookie, CSRF denial and logout revocation. The TLS certificate is an ephemeral local test fixture, not a deployed certificate. Reports/screenshots are in `artifacts/acceptance/R2/{auth,container/arm64}/`.

Redaction baseline: the first new raw-database test failed because configured credential text reached `runtime_events`. It passed after redaction moved before event, memory/FTS, content, audit and eval persistence. Structured secret fields are removed while numeric token usage and audit identity/correlation remain. Pino capture was nonempty and contained no synthetic secret. Existing databases are not retroactively scrubbed by R2; R3 migration/release must handle historical data separately.

## Dependency exposure triage

`npm audit --omit=dev --json --registry=https://registry.npmjs.org` on 2026-11-01 exits 1: zero high/critical, three moderate affected packages (`@fastify/static`, `glob`, `minimatch`), representing two underlying advisories: [glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249). This is a residual dependency risk, not a clean audit.

At locked static 10.1.8, `node_modules/@fastify/static/index.js` calls `glob('**/**', ...)` only when `wildcard:false`. The server explicitly uses `wildcard:true,list:false`; no user glob patterns are accepted. The wildcard path sends bounded requested files instead of invoking glob/minimatch. A behavioral regression creates a file after server startup and retrieves it, proving wildcard serving, and rejects encoded parent traversal. Thus the affected enumeration path is not reached by this configuration. Do not force the npm-suggested static 6 downgrade into Fastify 5. Re-audit at R10 and whenever static serving settings or these packages change. Public release still requires its own security decision.

## Boundaries and next batch

Browser sources are read-only, use a fresh sandbox-enabled browser, deny-only proxy, intercepted GET requests through pinned SafeNetwork, blocked service workers/WebSockets, bounded bytes/requests/deadline and cancellation. This is not a guarantee of full multitenant process isolation. Cloud has no registered arbitrary bash/write tool. Old local CLI/TUI browser/filesystem tools remain a separate local-user boundary, to be unified deliberately in R6.

No public DeepSeek call, cloud deployment, selected-cloud architecture, backup/restore or resource-isolation proof is claimed here. R3 starts only after this batch is committed and the remote branch SHA verified.
