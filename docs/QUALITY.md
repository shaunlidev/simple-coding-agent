# Quality

## Acceptance status

The 2026-11-01 review of commit `797ccb8` reopened production acceptance. Local tests passed before that commit, but targeted behavior checks and an actual Docker build exposed gaps. A passing local suite is not release approval.

The original scope remains in [0008 production plan](plans/active/0008-agent-ops-dashboard-production.md). Repair scope and acceptance gates are approved in [0009 acceptance recovery](plans/active/0009-agent-ops-acceptance-recovery.md).

R1 passed clean installation and native Linux arm64 container/browser checks; it was pushed as `98501c5`. R2 now passes authenticated session/role/CSRF, bound approval, actual network-boundary and pre-persistence redaction checks, including production-cookie HTTPS container verification. Details and limitations are in `docs/evidence/R1-clean-build.md` and `docs/evidence/R2-security-boundaries.md`. Neither closes cloud acceptance.

## Existing checks

- TypeScript strict checks and workspace builds.
- Package dependency-direction checks.
- Agent loop, provider streaming, tool argument, CLI, session, and TUI tests.
- SQLite runtime, scheduler, content, memory, security helper, and API tests.
- Agent Ops eval reports and dashboard/deployment file checks.

The existing dashboard and deployment checks inspect build output and file text. They do not prove browser workflows or container readiness.

## Open acceptance gaps

| Gap | Evidence from review | Repair |
| --- | --- | --- |
| Deployment target | Linux arm64 container passed; selected cloud platform and architecture remain unverified | R10 |
| Dependency advisories | Three moderate affected packages in unused glob/minimatch static enumeration path; no high/critical in official production audit | R2 triage; re-audit R10 |
| Historical secrets | New writes/outputs are redacted; existing databases are not retroactively scrubbed | R3 migration / R10 release |
| Legacy history completeness | R3 retains surviving rows and explicitly marks old receipts incomplete; previously discarded results cannot be recovered from count-only events | R3 evidence; R10 backup/release |
| Real dashboard agent | R4 controlled UI/browser and actual DeepSeek/public-source gates passed at exact pushed SHA `1a5d677` | R4/R5 checkpoint evidence |
| Schedule semantics | R5 timezone, durable queue, actual cancellation and real process restart/UI gates pass; exact-commit checkpoint pending | R5 evidence |
| Memory and practices | FTS storage exists, but use in model context and practice activation need verification | R6 |
| Honest telemetry | Real content events now contain actual usage; legacy demo metrics/default eval and security projections still require replacement | R7, R9 |
| User workflows | UI lacks the complete configuration, feedback, and inspection flows | R8 |
| Release evidence | Browser, cloud, restart, backup, restore, and rollback gates remain unverified | R9, R10 |

Record new regression coverage against behavior. A missing or skipped measurement remains unverified.

R3's normalized results, unique inbox ledger, request idempotency and transactional terminal events pass repeat/concurrent/restart/rollback checks. Actual process-restart and desktop/mobile history verification passed. R4's real executor extends that transaction with current-run citation checks and frozen task/source evidence. The first live attempt correctly failed on fake-IP DNS; the subsequent explicitly configured trusted-DNS run passed with actual provider usage. R5 preserves frozen queued work, fails interrupted attempts and prevents cancelled delivery. A process-held SQLite lock is tested on local storage, not on network/distributed storage. Legacy bytes in existing databases/backups are not retroactively scrubbed.

The default suite still reports two keyless DeepSeek tests as passed because those tests return early. They are NOT live model evidence; explicit skip reporting is required in R9. Existing bundle-word and deployment-file checks remain only static evidence, alongside the new actual R1/R2 browser/container gates.

## Rule

When a bug is found, add or update a regression test unless the reason not to is written here.
