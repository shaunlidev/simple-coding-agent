# R3 Run, Content and Delivery Consistency

Status: R3 behavioral acceptance passed on 2026-11-01; commit and exact-head rerun/push checkpoint follows. R2 pushed and verified as `f320f971fa15b7fba833101573588fb7e06266ef`.

## Work Sequence

- [x] Ground existing ownership and failure paths.
- [x] Compare two persistence designs and select the smallest coherent boundary.
- [x] Capture failing behavior tests against the baseline.
- [x] Implement versioned migrations, atomic results/delivery and request idempotency.
- [x] Validate event envelopes/payloads and deterministic replay; remove implicit demo reads.
- [x] Verify repeat runs, retries, failures, restart, migration and basic UI/API reasons.
- [ ] Record evidence, commit, push and verify exact remote SHA before R4.

## Existing Flow and Failure

`server -> RuntimeScheduler.runNow -> runDemoAgent -> runContentPipeline` is the present path. The runtime owns both event persistence and content rows. `content_items.id` is globally unique, while the row also has `run_id`. The pipeline emits `delivery.created` before `insertContentItems(...).onConflictDoNothing()`. Thus a repeat run advertises a nonempty digest while its rows are discarded. `snapshot` and `readyz` call `ensureSeeded`, so a read silently executes a demo. Migrations are unversioned SQL plus caught duplicate-column errors. Event validation checks nonempty strings but not known types, timestamps or payload contracts.

Keep SQLite/Drizzle, Fastify, React and the approved package directions. No scheduler-timezone, provider/model or full dashboard rewrite in this batch. R4/R5/R7/R8 remain required.

## Candidate Designs and Decision Criteria

A: normalized content identity + immutable per-run results + unique delivery ledger, committed with the result event in one runtime-owned SQLite transaction. B: event journal as sole authority with rebuildable result and delivery projections. Compared crash consistency, concurrent retries, baseline migration, smallest public API and compatibility with the existing event-based run projection. Independent read-only design reviews completed; no alternate implementation was merged wholesale.

Synthesis: select A. Both reviewers independently confirmed the global-content-ID and precommit-success defects. A expresses delivery uniqueness directly in SQLite and upgrades surviving baseline rows without pretending count-only legacy events contain missing item data. B's complete event-sourced result reconstruction adds snapshot/upcaster/rebuild machinery that the current consumers do not require. Retain B's insertion sequence, schema-versioned validation, terminal guards and explicit interrupted-run policy. The independent cross-judge also selected A, specifically requiring events inside the result transaction, idempotency before terminal rejection, a persistent zero-result receipt and a narrow run-replay claim. These are design judgments, not acceptance evidence.

Caller sketch: `admitRun({actor, key, intent})` returns a new or existing run ID; the executor only starts newly admitted work. `commitContentRun({runId, items, scope, maxItems})` atomically freezes candidate results, actual new inbox deliveries, a receipt/digest and success/skip event. `readRunResult(runId)` returns the frozen outcome, items and deliveries. Remove the old separate `insertContentItems` writer. Delivery scope is one shared workspace inbox, with demo runs isolated from live/manual scope. This is not a tenant-specific inbox product yet.

The chosen API must let callers submit a run's complete candidate results once, then read the committed results/outcome. Callers must not coordinate separate persistence and success-event writes. Request admission must atomically bind an idempotency key to one run and reject reuse with changed intent. Existing append-only events remain replayable, with a stable insertion order and schema version. Inbox delivery is a local transaction here, not an exactly-once guarantee for future external webhooks.

## Acceptance Matrix

| AC | Required behavior and evidence | State |
| --- | --- | --- |
| R3.1 | Three runs over identical source content retain per-run results; only first run delivers; event counts/digest/ledger agree. Failure injection rolls back success records. | Passed unit/SQLite and actual browser/API process gates |
| R3.2 | Later run returns explicit `no_new_items`, preserves first-run results and shows the reason in UI/API. | Passed API and desktop/mobile history selection |
| R3.3 | Concurrent and post-restart replay of the same actor/key/intent returns one run and one delivery; changed intent conflicts. No silent rerun of an unfinished admitted run. | Passed concurrent authenticated API and file reopen checks |
| R3.4 | Reopen a file database and reconstruct original states/results in insertion order. Unknown types, invalid timestamps/payloads and conflicting duplicate event IDs cannot enter storage. Queued/running/completed/failed/cancelled remain distinct. | Passed schema/lifecycle/replay and actual process restart |
| R3.5 | Fresh and baseline database upgrade, repeat migration, version rejection and transaction rollback work. Preserve historical rows without inventing already-lost results. | Passed five migration cases, including canonical merge archive |

Additional safety gates: snapshot/readiness/GET create no business records; demo seed is explicit and labeled; migrated records do not expose configured secrets; R2 network/auth/redaction regressions remain green. Historical data repair must not silently fabricate missing run outputs or claim retroactive complete secret erasure from old backups/WAL files.

## Verification Plan

Focused behavior tests use isolated SQLite and deterministic content fixtures. Exercise the actual API with authenticated sessions, repeated idempotency headers, and database close/reopen. A browser acceptance flow repeats Run now, inspects history and no-new-content reason, restarts the API and rechecks persisted results. Then check/build/boundaries/full tests/evals and the relevant R2 browser gates. Live DeepSeek and cloud evidence are not part of R3.

Baseline captured on 2026-11-01 before implementation: all three runtime regression cases and both API regression cases failed. The second run retained zero rows; a snapshot/readiness call created a demo run; malformed event timestamps were accepted; identical idempotency headers produced different run IDs. These failures are preserved here rather than replacing them with later green-only results.

Implementation references: [SQLite transactions](https://www.sqlite.org/lang_transaction.html), [SQLite UPSERT](https://www.sqlite.org/lang_upsert.html), and [Drizzle transactions](https://orm.drizzle.team/docs/transactions). Use a short synchronous SQLite transaction around admission/commit, with uniqueness constraints as the arbiter; do not hold it open across network/model awaits.

## Acceptance Evidence

- `npm run check`, build, package-boundaries and dashboard build passed. Full suite: 183 tests, 181 reported pass, 2 explicit browser skips, zero failures. As in R2, two reported DeepSeek passes are legacy early returns without a key, NOT live evidence. `npm run eval`: 11 reported pass, 2 skips with the same caveat.
- Focused R3 tests cover three repeat runs, zero-result receipts, delivery limit after duplicate exclusion, actual trigger-injected transaction failure, exact repeated commit and changed-input conflict, timestamp/payload/type/version rejection, same-ID conflict, queued/cancelled state replay and file reopen. Authenticated API tests cover three concurrent same-key requests, restart replay and different-target 409.
- Baseline migrations with and without the old evidence column passed. Original event IDs, insertion order and surviving content IDs/summary/score remain. Known missing rows are not fabricated. Nonempty original content rows are archived as `legacy_content_items`, including canonical duplicates; this is migration evidence, not a second runtime writer. Malformed URL migration rolls back both schema and data. Future versions/checksum changes fail closed.
- `scripts/verify-consistency.mjs` passed at `2026-11-01T02:57:34.931Z`: three UI runs, six retained result rows, two actual inbox deliveries, one delivery-created event and two skip events. Outcomes were `delivered`, `no_new_items`, `no_new_items`. Desktop 1440/mobile 390 had no page errors or horizontal overflow. Selecting the first run showed the original delivered results. After stopping and starting the actual API child process, session and exact historical response survived. Final exact-head rerun writes commit/dirty metadata to `artifacts/acceptance/R3/report.json`.
- `scripts/verify-auth.mjs` passed again at `2026-11-01T02:57:16.302Z`, including viewer/operator enforcement, approval-once, logout and UI redaction. R2 raw persistence, API, log and network regression tests remain green in the full suite.

## Remaining Boundaries

Run now is still the labeled demo executor. R4 must replace it with real provider/source execution; R5 owns worker leases, crash recovery and cancellation of actual work. R7 still owns removal of fixed usage/default telemetry. The new history selector is a bounded R3 acceptance surface, not completion of R8 navigation and workflows.

Migration does not erase historical credentials from original database pages, archived rows, WAL or backups. Authenticated API serialization redacts configured secrets, and new writes remain covered by R2. An existing database needs a deliberate scrub/rotation/backup decision before R10 release. No user's existing database or `.env` was used in these gates. All R3 content was controlled/demo content, with no paid model call and no cloud deployment.
