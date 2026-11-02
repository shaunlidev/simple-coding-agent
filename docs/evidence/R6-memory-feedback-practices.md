# R6 Memory, Feedback And Practices

Status: accepted and pushed as `efa9779dc987a2057572a207b5c6e03231fba119`.

## Previous Checkpoint

R5 is accepted at `6b99dfd89ff5403fb9885ca03f06931548adc133`, pushed to
`origin/fix/agent-ops-acceptance` and verified with `git ls-remote`.
Clean exact-head suite: 235 tests, 233 reported pass, 2 skipped, 0 failures.
The two old keyless live smokes still report pass without a live call; R9 owns
that reporting fix. Separate process and Chromium gates passed with `dirty:false`.
Process runs: `run-29eeb64d-8cee-4509-b062-6509774596f3` (interrupted),
`run-e4d92560-418d-4d77-8610-f6c10db5e29b` and
`run-0fe0e1d8-47ab-464a-bdb0-28ae8844c440` (resumed queue).
Browser cancellation: `run-fe9408ce-06bf-4258-8004-2a686ef024ae`.
Both gates used controlled providers; neither proves cloud deployment.

## Grounding

`SQLiteRuntimeStore.readMemory` currently adds hard-coded preferences, lessons
and feedback even after clearing all rows. Feedback appends every retry and
ranking only sees the latest twenty records. Entry and FTS writes are separate.
`executeContentRun` does not read memory at all: its prompt and final score come
only from the task and provider. The older demo pipeline reads memory, which
explains why existing green tests did not prove production behavior.

`coding-agent/tasks.ts` independently owns JSON task state, preferences,
feedback, scheduling, RSS parsing, browser collection, scoring and Markdown
digests. Those commands cannot see Dashboard tasks and bypass the shared
network/worker/result boundaries. R6 will migrate callers before deleting this
duplicate implementation; workflow documents remain separate by design.

## Scope And Order

- [x] Ground actual call paths and inspect original Phase 7 / recovery R6 AC.
- [x] Compare two architectural candidates and record the chosen interfaces.
- [x] R6-A: transactional persistent memory, idempotent feedback and FTS.
- [x] R6-B: admission-frozen model context and explained next-run ranking.
- [x] R6-C: evidence-backed practice review, eval, activation and rollback.
- [x] R6-D: CLI/TUI compatibility over the shared task/runtime state.
- [x] API/browser/process verification, regression gates and evidence.
- [x] Independent commit, clean exact-head verification, push and remote SHA.

Each implementation unit gets its behavioral check before the next unit.
The original stack and scope remain unchanged. Full Dashboard navigation and
polish remain R8, but R6 must expose operable endpoints and enough UI to perform
its feedback/practice manual acceptance. R7 owns usage/trace/retention; R9 owns
the broader mutation harness. R6 practice gates must already be real checks.

## Planned Boundaries

The runtime owns memory and practice transitions, not HTTP payloads or UI state.
Server authentication supplies actor IDs. Retrieved notes are data with source
provenance, never system instructions or tool authority. Content sources cannot
write memory or approve practices. SQLite remains the single workspace store.

Capture the exact bounded memory/retrieval/practice context at admission, before
the first model request, and persist it with a hash. Subsequent feedback cannot mutate an
in-flight run's context. Actual prompt evidence must identify retrieved entry
IDs, sources and the active practice version; no hits means an empty list.
Ranking retains the model base score and deterministic, bounded adjustments.

Practice candidates require existing run/feedback evidence and immutable
versions. Review and evaluation are separate server-side transitions. A client
cannot submit `passed`, trust, actor or an arbitrary eval report to activate a
candidate. Activation uses the exact reviewed/evaluated version and requires
operator approval. Rollback records history and restores the prior eligible
version; it does not rewrite earlier run inputs.

Memory clear removes live preferences, feedback, searchable notes and active
practice influence. Historical run inputs/results and audit records are not a
secure-erasure feature; their retention/deletion policy must be explicit and
will be completed in R7. Clearing must not reinstall demo/default memory.

## Architecture Decision

Two independent read-only candidates were compared. A proposed typed practice
rules and an embedded SQLite CLI host. B proposed an HTTP-only task client and
free-text practice releases with model-backed semantic evaluation. A preserves
standalone task execution and mechanically enforceable behavior; B makes remote
terminal operations simpler but requires a running API and a materially larger
semantic release gate. Select A. New rule kinds require code review; this does
not claim arbitrary autonomous self-modification.

`RuntimeMemory` owns transactional entries/FTS/feedback and frozen contexts.
`RuntimePractices` will own immutable definitions, evidence, reviews, reports and
an optimistic-concurrency active pointer. Rules are minimum quote count, per-source
delivery cap and bounded source rank bias. The human-readable principle is stored
for review, never interpolated as a system instruction. Compiled instructions
come from fixed application templates. Report upload/`passed: true` is not an API.

Local task operations use the same DB path, authenticated local principal and
worker lock as the API. An already-running API worker causes an explicit execution
ownership conflict, not a second executor. Digest files are exports. Legacy files
are only read by an explicit idempotent importer and remain preserved.

Borrow B's useful guardrails: clear increments a memory epoch and fences unfinished
old-context writes; candidate evaluation binds the active revision, memory epoch,
memory digest and evaluator suite hash. History remains immutable. Workspace-wide
memory is not presented as private per-user storage.

## Acceptance Matrix

| AC | Required behavior and evidence |
| --- | --- |
| R6.1 | Same fixed candidate set, controlled identical provider scores: saved increases and not-interested decreases next-run rank with reasons; repeated same actor/item/signal does not stack; changing a signal replaces its influence; restart preserves it. |
| R6.2 | Actual content executor passes matching FTS knowledge to provider with entry/source IDs; captured input and persisted context agree; no-match and punctuation queries do not fabricate hits or throw SQL syntax errors; later memory edits do not mutate captured context. |
| R6.3 | Empty/cleared memory is empty; entry/FTS/event changes roll back together on an injected failure; viewer and forged actor/trust writes are denied; external instructions cannot activate a practice; export is redacted; approved clear removes future influence. |
| R6.4 | Candidate linked to real stored run/feedback evidence is reviewed, evaluated and explicitly activated; next run records and uses its exact version; rollback restores prior behavior; failed, changed, unreviewed or stale-baseline candidates never activate; evaluator reports actual checks, not a client success flag. |
| R6.5 | CLI/TUI and Dashboard API create/list/read the same task IDs and preferences from the same SQLite path; real runs use the shared source guards and scheduler ownership; legacy file import is explicit, idempotent and preserves originals; compatibility commands still create/run/feedback/preferences/digest and fail clearly when live credentials or ownership are unavailable. |

Manual acceptance: create two content items, save one and reject the other,
rerun, inspect score adjustments and actual model context, then review/evaluate/
activate a candidate, rerun and roll back. Restart the process and compare the
same state through CLI and authenticated API. Use actual Chromium for UI steps;
label controlled model data separately from live model evidence.

## R6-D Implementation Contract

Keep terminal command names while replacing the file runtime. Add a local host
composition in `runtime` (SQLite path, guarded network, provider and scheduler),
and move credential parsing/comparison from Fastify-specific code into `security`.
The terminal adapter authenticates `AGENT_LOCAL_USER` / `AGENT_LOCAL_SECRET` against
the same `AGENT_AUTH_USERS`; viewer can read, operator can mutate. Credentials
come from the environment, never command-line flags or model inputs. Database
write access itself remains inside the trusted-host boundary.

`tasks.ts` becomes a thin compatibility adapter over this host, not a second
collector, scorer or scheduler. Shared create-with-schedule is transactional.
`--cwd` resolves the default `data/agent-ops.sqlite` and relative `AGENT_DB_PATH`
against the workspace. Run/daemon uses the existing worker lock, abort and drain;
a running API owner yields an explicit conflict. Real tasks require the key and
the same allowlist. No silent network or model fallback.

Preserve explicitly requested `--source mock` as a labeled demo task in the shared
content-task schema/executor. This requires an explicit task mode and bounded mock
source data; production rejects demo execution. Omitted source no longer silently
creates a fake live task. RSS/browser/URL remain real sources. Keep the older
explicit server demo fixture used by historical regression gates separate from
normal configured task execution. All new content tasks share admission/results.

Digest files are per-run Markdown exports of committed SQLite receipts. Existing
workflow documents are unaffected. `import-legacy` reads only the workspace's
old `docs/agent` files, records a source-manifest hash and ID mapping, imports
configuration transactionally with schedules paused, and never overwrites source
files or fabricates past model/source evidence. Ambiguous legacy feedback/history
must remain labeled or quarantined, not promoted into trusted practice evidence.

Unit checks before UI acceptance: task API/CLI identical IDs and preferences,
actual process CLI commands and TUI behavior, missing/invalid credentials, viewer
writes, worker conflict, guarded real browser/RSS paths, explicit demo labeling,
legacy import retry/conflict, per-run digest preservation and no old file writes.

## R6-E Dashboard Contract

Use the existing Dashboard layout and tokens for this bounded unit; the complete
navigation/layout redesign stays in R8. Operational controls, not spec text:
content feedback icon buttons with current actor state and retry-safe requests;
editable preferences, knowledge search/add and redacted export; a separate
clear confirmation routed through the existing bound approval executor; immutable
practice proposal, review, regression report, explicit activate and rollback.
Run details expose the actual frozen memory hash/entries/practice version.

The visual baseline is the current display-only Memory section. Preserve its
type scale; use compact unframed form/list areas and 4px controls, existing green
success/red errors with blue selected controls, and Lucide icons with accessible
names/tooltips. No new landing page, card nesting or documentation panels.
Browser AC: save/reject two identical-score results, rerun and inspect 68/5;
add/retrieve a note into actual provider input; propose/review/evaluate/activate
a quote policy, run with its version, then roll back; clear removes future
influence but retains historical inputs; denied viewer controls, pending/error
states, desktop/mobile overflow and process restart are verified separately.

Before closing R6, replace the inherited current-value projection labeled as
preference diffs. AC: additions, replacements and removals record actual before/
after values in the same transaction as preferences; no-op edits add no diff;
feedback remains separate from source-weight edits; restart preserves history;
clear removes live history. Existing legacy entries have unknown prior values,
not invented historical changes. Add a failing regression before this repair.

## Sources And Design Constraints

- [SQLite FTS5](https://www.sqlite.org/fts5.html): use a parameterized MATCH
  expression and maintain the index with the authoritative rows transactionally.
  User search is plain text, not an exposed FTS query language.
- [LangGraph memory concepts](https://github.com/langchain-ai/docs/blob/main/src/oss/concepts/memory.mdx): distinguish facts/preferences, episodic evidence and
  procedural practices. This informs the domain split; it is not a framework
  change or an endorsement of autonomous rule promotion.
- [LangGraph store reference](https://reference.langchain.com/python/langgraph.store/base): long-term memory has explicit identity/scope separate from one
  conversation. This product remains one shared workspace, not multi-tenant.

## Evidence And Limitations

R6-A baseline: all four new tests failed for the expected defects (defaults,
duplicate feedback, non-atomic entry/FTS/event, raw FTS punctuation). First failure
log: `/private/tmp/agent-r6-memory-baseline.log`. All passed after implementation;
database migration checks also passed (9 combined tests).

R6-B baseline: both actual-executor tests failed (unchanged scores and absent
knowledge input), recorded at `/private/tmp/agent-r6-context-baseline.log`.
After wiring, identical model scores of 50 become 68 for saved and 5 for not
interested, without duplicate weighting. Provider input contains exact note ID,
actor and source URL. Historical context survives clear, while new context is
empty; clear also fences unfinished old-epoch writes.

Interim full suite after practice/API implementation: 248 total, 246 reported pass,
2 skipped, 0 failures; check/build
exit 0. This is controlled-provider evidence, not live-model semantic quality.
At that checkpoint R6-D and UI acceptance were pending; their completed evidence follows.

Independent review reproduced two missed behaviors: rollback could restore a rule
whose feedback evidence had since been superseded, and an already-delivered item
could consume the source quota and starve new content. It also found that the
evaluation hash covered helpers but omitted evaluator and commit enforcement.
Fixes under verification: re-evaluate rollback targets against current evidence
and preserve failed reports; enforce quotas only for eligible new deliveries in
the completion transaction; hash the complete executing runtime implementation,
including the embedded regression suite. These have dedicated regression tests.
The new starvation fixture first failed because a stream-options argument shadowed
its fixture-options value (expected score 90, actual 50); the fixture was corrected
without changing production scoring or relaxing the expected outcome.

All three review findings were fixed and independently rechecked. An additional
review found that build changes could not requalify unchanged active rules;
explicit `build-revalidation` now rechecks the same version and creates a new
activation record with current bindings. A source-to-dist, same-database test
proves this path. Reviewer confirmed no residual within those findings.
Final targeted memory/practice/API gate: 17 pass, 0 failures. Latest full suite
before the final build-revalidation test: 251 total, 249 reported pass, 2 skipped.
R6-C is a verified implementation unit, not R6 overall acceptance.

R6-D: identity parsing now lives in security; terminal task commands use the
shared SQLite host, Agent executor, network guards and worker lock. Eight adapter
checks cover atomic task/schedule and legacy imports, feedback replacement,
unique digest exports, actual RSS path, browser adapter and daemon ownership.
Actual CLI subprocess and TUI commands passed; authenticated API integration
proved identical tasks/preferences/feedback and next-run scores after reopening.
Actual Chromium collection also passed with controlled source/provider data.
Legacy files remain unchanged; uncertain history is not promoted into evidence.

First failures retained in tool history: the browser test adapter used the wrong
argument order, the subprocess test failed on URL-encoded workspace spaces, and
the API test requested a nonexistent memory endpoint. These were fixture errors
fixed against actual interfaces (including fileURLToPath), not weakened assertions.
The first full gate had a single localhost-listen EPERM in the existing security
test (`/private/tmp/agent-r6-terminal-tests.log`). The permitted-localhost rerun
passed: 260 total, 258 reported pass, 2 skipped, 0 failures
(`/private/tmp/agent-r6-terminal-tests-escalated.log`). The known keyless smoke
reporting issue remains R9; these counts are not live-model evidence.

## R6-E Acceptance

Actual Chromium at 1440px and 390px passed the authenticated Dashboard flow:
create a task; edit/reset preferences; add and retrieve a knowledge note; run;
save one result and reject another; rerun with identical model scores. Scores
changed from 50/50 to 68/5, with reasons. The provider input and frozen context
both contain the exact note ID and provenance. A simulated lost response after
the feedback transaction committed was retried with the same key; history has
one write, not two.

An evidence-linked practice was proposed, reviewed, evaluated and explicitly
activated through the UI. The next run recorded its immutable version and used
at least two quotes per item. Rollback removed that influence on the next run.
A negatively biased rule contradicting saved feedback failed its real regression
report and could not activate. Export contained recorded feedback and knowledge
but no configured secret. Approval-bound clear removed future memory influence;
the next scores were 50/50 and historical run inputs remained unchanged. Viewer
write controls were disabled. No browser errors or horizontal overflow occurred.

Reports and screenshots: `artifacts/acceptance/R6/ui-report.json`,
`practice-desktop.png`, `practice-mobile.png`, `feedback-run-desktop.png`.
This gate uses an actual UI/API/SQLite/Chromium with controlled RSS and provider
responses, not live-model semantic quality evidence.

The process gate starts the real API entry, executes the same SQLite task, saves
feedback/knowledge and activates a practice, then SIGTERMs the API. A separate
CLI process lists and executes the task while the API is stopped. After API
restart, exported memory and the historical result equal their earlier values;
the CLI run retains knowledge, practice version and feedback score. Report:
`artifacts/acceptance/R6/process-report.json`. This uses an explicitly labeled
demo task and does not prove cloud deployment.

First UI fixture failures are retained at `/private/tmp/agent-r6-ui-first.log`,
`agent-r6-ui-second.log`, `agent-r6-ui-third.log` and
`agent-r6-ui-expanded.log`: cloning an executable context, an incorrect response
shape, ambiguous search label and select-label text. Fixes use actual serializable
provider inputs, response fields and accessible roles; assertions were not relaxed.
The first process fixture polled `/health` instead of `/healthz`, recorded in
`/private/tmp/agent-r6-process-first.log` and corrected against the server route.

Final original-scope review found inherited preference diffs reconstructed from
current entries, losing removal/replacement history and mislabeling feedback as
source-weight edits. The new regression failed before repair
(`/private/tmp/agent-r6-preference-history-baseline.log`). Actual before/after
diffs now commit with entries/FTS/events, skip no-op changes, survive reopen and
clear with live memory. Legacy entries do not acquire fabricated history.
The browser verifies the actual removal record, not just the section heading.

Pre-commit gates on macOS arm64, bundled Node 24.22.1:

- `npm run check`, `npm run build`, `npm run check:package-boundaries`,
  `npm run dashboard:build`, `git diff --check`: exit 0.
- Full suite: 261 tests, 259 reported pass, 2 skipped, 0 failed
  (`/private/tmp/agent-r6-history-tests.log`). Keyless smoke reporting remains
  the known R9 gap, not live evidence.
- `npm run eval`: 13 tests, 11 reported pass, 2 skipped, 0 failed.
- Expanded R6 UI and actual-process gates: exit 0
  (`/private/tmp/agent-r6-ui-history.log`, `agent-r6-process-history.log`).
- R4 controlled content/UI and R5 process/Chromium cancellation regressions:
  exit 0 (`/private/tmp/agent-r6-r4-regression.log`,
  `agent-r6-r5-process-regression.log`, `agent-r6-r5-ui-regression.log`).

These are pre-commit checks with `dirty:true`. The next checkpoint must record
the clean exact SHA, rerun the gates, push and compare the remote SHA before R7.

## Clean Checkpoint

All listed local commands and R4/R5/R6 process/browser regression gates passed
at `efa9779dc987a2057572a207b5c6e03231fba119`; the worktree was clean and R6
reports record `dirty:false`. Full suite: 261 total, 259 reported pass, 2 skipped.
Eval: 13 total, 11 reported pass, 2 skipped. No failures. Logs:
`/private/tmp/agent-r6-exact-{build,tests,eval,ui,process,r4,r5-process,r5-ui}.log`.
UI runs include `run-03050203-1254-420b-8d51-b3d58730496f` with practice
`8f8360bd-8c29-4366-a13b-f9160555633e`; restarted terminal run:
`run-0f721545-b98b-48a4-9dda-e51fe5f7415e`.
`git push origin fix/agent-ops-acceptance` succeeded and `git ls-remote` returned
the same full SHA. This closure note is recorded with the following R7 work,
without amending the accepted checkpoint. R7-R10 remain unaccepted.
