# R5: Durable Scheduling, Cancellation and Recovery

Status: implementation and pre-commit behavior acceptance passed; final gates and exact-head checkpoint pending. Baseline: `1a5d677c16ede4ed2e9f59eb37dcff74f4e17f66`.

## Prior Checkpoint

R4 was independently committed and pushed at the baseline SHA; `git ls-remote` matched. Clean exact-head full suite: 219 total, 217 reported pass, 2 skip, 0 fail (old keyless smoke caveat remains). Actual Dashboard/API/Chromium gate passed with run `run-597964dc-a0a4-4e06-99df-25ccd7e6f44c`. Live DeepSeek/public RSS/Chromium gate passed with run `run-63b9b691-ba7b-4873-9495-c152cea6c9bd`, two calls, 2,281 input and 340 output tokens (2,621 total). Reports record `dirty: false`; R4 is closed, not a cloud-ready declaration.

## Work Plan

- [x] Ground scheduler, server execution ownership, run persistence and migration boundaries.
- [x] Compare durable-job and event-replay designs; choose one and record caller contracts.
- [x] Reproduce host-timezone failure; add behavior cases for durable FIFO, actual cancellation, missed runs and second-worker refusal.
- [x] Implement validated calendar calculation and versioned persistence; migrate callers and remove the replaced scheduler.
- [x] Wire manual/scheduled execution and cancellation through one owner, including graceful stop and restart recovery.
- [x] Run focused/full tests and real process/API/browser acceptance; record evidence and limitations.
- [ ] Independently commit, rerun exact-head gates, push and verify remote SHA.

## Grounding

`RuntimeScheduler` currently lives inside runtime/index.ts. It polls node-cron once per minute, keeps active promises and a Set of queued schedule IDs in memory, and marks `cancel_previous` only as an event. The server separately owns actual AbortControllers. Queue entries therefore have neither durable identity nor FIFO order, cancellation cannot reach the executor, and a restart loses both. `nextRunAt` hand-parses only a subset of cron and uses host-local Date operations, ignoring schedule.timezone. Admission/result commits are already synchronous SQLite transactions and must stay authoritative.

R5 keeps node-cron, SQLite and the R4 executor. A scheduler module should own admission/dispatch/cancellation; server supplies only the executor callback and authentication. Run snapshots and content results stay in the runtime store. One configured worker operates the shared database; this is not a distributed queue claim.

## Acceptance Contract

| AC | Required behavior and proof |
| --- | --- |
| R5.1 | Shanghai 09:00 resolves to the same UTC instant under UTC and Shanghai host TZ; weekday cron and DST gap/fold cases are pinned. Invalid expression, interval, timezone and timestamp return 4xx before persistence. |
| R5.2 | Skip consumes one trigger without duplicate execution; queue preserves every accepted logical run in FIFO order; cancel_previous aborts provider/fetch/browser, drains the old execution before replacement and forbids old delivery. |
| R5.3 | Admission and due-cursor advancement are atomic; repeated ticks/manual keys do not duplicate a trigger. Queued work survives process restart. An interrupted running attempt becomes explicit interrupted/failed, never silently reissued as the same attempt. Each overdue schedule coalesces to at most one catch-up, with missed range recorded. A second live worker is refused. |
| R5.4 | Pause prevents new automatic admission, resume computes a future occurrence without replaying the paused interval. Already admitted work remains inspectable/cancellable. Manual Run now is explicit and does not move the automatic cursor. All paths share the R4 executor. |
| R5.5 | API/UI nextRunAt, actual lastRunAt, scheduledFor and trigger reason match persisted execution. Actual browser controls/API cancellation and a real restart exercise the contract, not just screenshots. |

Files: runtime scheduler/time modules and store event boundary; db migration; server lifecycle/run/schedule routes; focused scheduler/API tests and process verifier; minimal scheduler/cancel UI (full R8 scope remains). No memory, pricing or deployment scope is removed or folded into R5.

## References

- [node-cron options](https://www.nodecron.com/scheduling-options.html): explicit timezone and noOverlap govern the polling task; application-level overlap still needs durable state and AbortSignal.
- [cron-parser](https://github.com/harrisiirak/cron-parser): timezone-aware next/previous occurrence calculation and DST behavior. Official registry on 2026-11-01 reports 5.10.3, Node >=18; verify installed behavior before acceptance.

## Selected Design

Candidate A uses indexed durable jobs; B derives pending work by replaying the event ledger. Select A for direct FIFO/inspection and bounded dispatch queries, while borrowing B's dedicated sibling SQLite exclusive lock. Do not add an expiring lease on top: the deployment is explicitly one host with local persistent storage, and ownership stays held until abort/cleanup drains or process death releases the OS lock. Heartbeat in R7 is health evidence, not permission to take over a live worker. Do not remove/replace the lock file while running. Distributed/network-filesystem deployment remains unsupported.

`RuntimeScheduler` keeps a small API: `start`, `stop`, `tick`, `runNow(scheduleId, identity)`, `runTask(taskId, identity)`, `cancel(runId, actor)`. Server injects `runAgent({runId, signal})` and no longer owns another execution map. SQLite jobs own queue order/state; transitions and lifecycle events share transactions. The runtime store exposes a synchronous event insertion boundary for composing those transactions, retaining asynchronous callers. Existing result completion atomically updates the job terminal state as well.

Jobs use an increasing sequence, unique run ID, task overlap scope, optional schedule ID/revision/nominal timestamp, trigger, reason and state. Global concurrency is one. Direct task Run now defaults to queue; schedule requests use the configured overlap policy across the same content task. Cancel records intent and fences writes before aborting. A replacement remains queued until the previous executor settles. Cancelled work cannot commit source observations or delivery; already-sent network calls cannot be undone.

Automatic identity hashes schedule ID, revision and persisted due cursor, not tick arrival. Admission, frozen task snapshot, job insertion, event and cursor advance commit together. Missed intervals preserve phase and exact count; cron catch-up records first/last missed range without unbounded enumeration or an invented count. Resume skips the paused window; manual requests leave the automatic cursor unchanged. Existing keys resolve original targets before mutable config is consulted. Invalid clock configuration fails before storage.

The calendar baseline failed all three new tests (UTC mismatch, DST mismatch and missing validation). With pinned cron-parser 5.10.3 all three pass, including subprocesses with UTC and Shanghai TZ. DST follows the tested parser policy: nonexistent spring times shift forward; the already-observed fall fold is not replayed.

## Evidence

Implementation uses migration v4; prior migration checksums are unchanged. The old in-memory queue, fake replacement event and hand-written date fallback were removed. Server manual/scheduled paths use one worker. `run.cancel_requested` fences writes while cleanup is still in progress; `run.skipped` distinguishes overlap skips from failed execution. Source/result commits and terminal jobs remain transactional.

Independent design cross-check conditionally accepted the synthesis: cancellation must fence delivery in the transaction, the lock must precede recovery, claim/start and terminal job/event writes must be atomic, pending work participates in overlap, and every server execution entry must share ownership. These conditions were applied; the design review itself is not execution evidence.

| AC | Verification and result |
| --- | --- |
| R5.1 | Three calendar tests passed after all three failed at baseline. Separate UTC/Shanghai processes produce `2026-11-01T01:00:00.000Z` for Shanghai 09:00. Weekday, spring gap/fall fold and invalid configuration are checked. API tests reject invalid cron/interval/timezone and client-controlled runtime timestamps. |
| R5.2 | FIFO retains three separately admitted runs; retries do not add jobs. Skip and cancel_previous include queued/manual work for the same task. Cancellation-before-commit rejects delivery and stage writes; replacement waits for a controlled cleanup barrier. Actual provider, URL and RSS AbortSignals are checked through authenticated API requests. The real Chromium/UI gate observed one started transport, one abort, one model fixture request and no delivery. |
| R5.3 | Injected job-insert failure rolls back admission and due cursor. Seven overdue interval occurrences coalesce once; repeated ticks create no second job. Actual separate-process lock refusal, SIGKILL and restart passed: first run failed as interrupted, next two completed in original FIFO order, frozen task snapshots and nextRunAt retained. Legacy terminal retries and queued snapshots are preserved; unknown unfinished attempts fail explicitly. |
| R5.4 | Pause prevents automatic admission; Run now works while paused without moving the cursor; resume skips elapsed intervals and retains phase. A real node-cron timer test (no manual tick) verifies automatic execution, pause and resume. R4's manual/scheduled same-executor test still passes. |
| R5.5 | UI creates a schedule, runs it, cancels an actual browser read, pauses/resumes and checks persisted timestamps/trigger. Desktop 1440x1000 and mobile 390x844 pass overflow checks; mobile screenshot was visually inspected. Trigger is read from actual started jobs, not overwritten by schedule-edit events. |

Actual process report: `artifacts/acceptance/R5/process-report.json`, with interrupted `run-c7c6f75a-4217-4f2b-8a89-c1bd24749d76` and restored `run-186e7b10-9ced-4cd3-bc42-6e7b905ada43` / `run-482ee1a8-13cc-4f27-910f-7cba05c1a38d`. Actual UI/browser report: `artifacts/acceptance/R5/ui-report.json`, run `run-a3b6ca15-2ecb-48ef-96a2-034814ba4536`. These use controlled provider/source responses, not live DeepSeek. Pre-commit reports truthfully record baseline SHA with `dirty: true`.

The first process verifier failed because its synthetic URL response omitted Content-Type; the production collector correctly rejected it. The fixture now declares text/plain and handles failed tool results explicitly. The diagnostic rerun is retained in `process-failure-*.json`. This was not repaired by weakening source validation. A review also caught that stopping a refused in-memory worker could release another owner's marker; ownership-checked release and a three-worker regression fix it.

Existing R3 actual server/process-restart/history gate passed again at 2026-11-01T04:04:22.031Z: three runs, six run results, two unique deliveries, session and historical results preserved. R4 controlled actual Dashboard/Chromium gate also passed, run `run-f8221848-aebb-40f7-a548-395405ecd25d`. Full regression before the final real-timer test: 234 total, 232 reported pass, 2 skip, zero failures. Eval: 13 total, 11 reported pass, 2 skip, zero failures. The old early-return keyless smoke caveat remains; no extra live-model evidence is claimed by those counts.

Build, strict check, package boundaries and Dashboard build returned 0 on bundled Node 24.19/macOS ARM64. Official production dependency audit returned 1 with the existing three moderate affected packages, zero high/critical. cron-parser 5.10.3 is pinned in the lockfile. Final exact-head counts and process/UI reports are required after the R5 commit.

### Original Phase 5 Coverage

| Original criterion | Current proof |
| --- | --- |
| Daily 9 AM configurable | API creation test plus cross-host timezone calculation; UI exposes cron/timezone fields. |
| Paused schedule does not trigger | Controlled clock and actual node-cron pause/resume tests. |
| Manual/scheduled same path | Server content-agent test and removal of server's direct execution map. |
| Overlap policies tested | Persisted FIFO, skip, task-scope queued cancellation, cleanup barrier and no-delivery checks. |
| Dashboard next/last/enabled/reason | Actual browser creation/run/cancel/pause/resume with API/SQLite and time-element assertions. |

### Boundaries

This is single-host/local-disk cooperative ownership, not distributed scheduling or exactly-once remote effects. Already-sent provider requests may still be billed. A stuck executor blocks replacement rather than falsely reporting cleanup; R7 will expose health/stale state and R10 will validate operational recovery. No cloud/container release is accepted here. R6 memory/practices, R7 telemetry, R8 full product flows, R9 harness report lineage and R10 deployment remain open.
