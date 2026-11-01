# Quality

## Acceptance status

The 2026-11-01 review of commit `797ccb8` reopened production acceptance. Local tests passed before that commit, but targeted behavior checks and an actual Docker build exposed gaps. A passing local suite is not release approval.

The original scope remains in [0008 production plan](plans/active/0008-agent-ops-dashboard-production.md). Repair scope and acceptance gates are proposed in [0009 acceptance recovery](plans/active/0009-agent-ops-acceptance-recovery.md).

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
| Clean installation | No declared TypeScript dependency; checks rely on global tsc | R1 |
| Container readiness | Docker build fails during better-sqlite3 installation | R1, R10 |
| Authorization | Anonymous requests can write and export memory; approvals trust client input | R2 |
| Execution policy | Pipeline fetch can bypass the standalone allowlist check | R2, R4 |
| Content/run consistency | Repeated runs can have a nonempty digest with no latest-run result rows | R3 |
| Real dashboard agent | Default execution uses mock sources and extractive summaries | R4 |
| Schedule semantics | Host timezone affects execution; cancellation does not stop the old task | R5 |
| Memory and practices | FTS storage exists, but use in model context and practice activation need verification | R6 |
| Honest telemetry | Usage values are fixed; empty reports display passed; sandbox enabled is a default | R7, R9 |
| User workflows | UI lacks the complete configuration, feedback, and inspection flows | R8 |
| Release evidence | Browser, cloud, restart, backup, restore, and rollback gates remain unverified | R9, R10 |

Record new regression coverage against behavior. A missing or skipped measurement remains unverified.

## Rule

When a bug is found, add or update a regression test unless the reason not to is written here.
