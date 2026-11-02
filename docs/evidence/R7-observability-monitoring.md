# R7 Observability And Monitoring

Status: R7-A through R7-E implementation, behavioral acceptance and frozen-tree regression passed, including bounded live usage and separate-process interruption. Clean commit/push verification remains. R7 is not yet closed.

## Previous Checkpoint

R6 is accepted at `efa9779dc987a2057572a207b5c6e03231fba119`, clean exact-head
UI/process/regression gates passed and the remote branch SHA was verified.
See R6 evidence for commands, counts, run IDs and controlled/live boundaries.

## Work Sequence

- [x] Ground current telemetry, provider usage, scheduler and readiness paths.
- [x] Frame and compare two structurally distinct architecture candidates.
- [x] Cross-review, select and document types/ownership and AC.
- [x] R7-A: truthful usage, versioned pricing, metrics and unknown states.
- [x] R7-B: real operation spans, parent linkage and bounded trace export.
- [x] R7-C: pre-call budget admission, post-call accounting and actual abort.
- [x] R7-D: persisted heartbeat, readiness, alerts and retention.
- [x] R7-E: API/UI/process acceptance and relevant regressions; final frozen-tree rerun below.
- [ ] Independent commit, clean exact-head verification, push and remote SHA.

No stage narrows original 0008 Phase 9/10 or recovery R7. Each implementation
unit ends with its behavioral gate. Preserve single-host worker ownership,
admission-frozen inputs, atomic results, redaction and reviewed practice gates.

## Initial Grounding

The live content path already measures model/tool durations and records provider
usage. DeepSeek requests streaming usage and bounds output tokens. The current
snapshot instead sums optional event counters with zero defaults, projects spans
from completion events with fallback durations, mixes run/tool latency samples,
and substitutes default passed evals and enabled sandbox status on an empty DB.
The older explicit demo pipeline fabricates paid-model usage and latency.

The Agent loop pushes observation events asynchronously; subscribers are not
pre-dispatch authorization hooks. Budget enforcement must be in the actual
provider/tool dispatch path, not a Dashboard event subscriber. A missing final
stream usage response cannot be represented as free. Prices must be frozen per
call, not recomputed from current config when reading old runs.

### Current Flow

Events are the replay input. `appendEventSync` validates/redacts and updates
scheduled job transitions transactionally. Snapshot projects the latest admitted
run, which can hide an older active run. `projectRun` counts pipeline events as
tool calls; `spanFromEvent` omits actual model/tool/source events and uses completion
timestamps as starts. `projectMetrics` mixes all positive event durations with
no time window. Empty state defaults to success, four passed evals, a secret scan
pass, enabled sandbox and a fabricated denial. These must be removed, not relabeled
as production evidence. Anchors: runtime `index.ts` at the R6 checkpoint, lines
302, 363, 952, 993, 1018, 1266 and 1292.

The scheduler owns a separate SQLite lock, durable queue and single active
execution. `stop` aborts, drains, then releases ownership. Recovery fails interrupted
attempts and keeps queued work. There is no heartbeat record. Server readiness
only runs `select 1`, so DB errors become generic 500 rather than 503. Snapshot
polling is not heartbeat. Anchors: `scheduler.ts` start/stop/tick/pump and server
`index.ts` health routes. Retain these ownership and terminal-transaction semantics.

DeepSeek usage is parsed at the provider boundary but its legacy `cacheWriteInput`
name currently means cache misses. Validate cache breakdown consistency and name
the semantics explicitly. The common provider dispatch receives only AbortSignal;
output limit is fixed in the DeepSeek factory. R7 must govern each actual call,
including thrown/aborted/missing-usage responses, before the loop advances.

The existing telemetry tests verify positive fixture numbers, not observed
measurements. Replace their assumptions with actual dispatch and persisted-state
checks. One independent read-only explainer confirmed the above current flow.

Provider-boundary regression before accounting work: cache hit/miss counts cannot
exceed input counts or contradict each other; the documented nested cached-token
field is recognized, but conflicting nested/top-level values are rejected. Test
both streaming and non-streaming responses. Missing fields remain unknown, not
inferred zero. This boundary is independent of the selected runtime storage shape.

### Architecture Evaluation

Architect checklist: grounding complete; sketch underway; synthesis/implementation
pending; redesign if invariants cannot be enforced through the chosen interfaces.
Arena checklist: frame complete; two candidates underway; cross-judge, selection,
graft and verification pending. The configured external model families are not
available in this harness; candidates inherit the parent model and receive
different structural directions, not a claim of cross-model diversity.

Both candidates completed. A retains authoritative measurement events and adds
two awaited Agent dispatch wrappers; B adds runtime-owned operation/call records
and governed provider adapters. Parent provisionally prefers A's single fact
store and deep dispatch wrapper, with B's transport-adjacent recheck. Cross-judge
is checking the five criteria: existing ownership, dispatch/settlement safety,
unknown/crash truth, interface depth/testability, retention/monitoring invariants.
Candidate artifacts are under `/private/tmp/agent-r7-design-{a,b}/design.md`.

### R7-A Pricing Unit Contract

Both architectures share this independent pure unit, so it can be verified before
runtime integration. Add `runtime/pricing.ts` with schema-validated, versioned
model rate catalogs and per-call frozen rate snapshots. USD rates use integer
microdollars per million tokens; calculate with bigint intermediates, round the
combined call estimate upward to integer nanodollars, and reject unsafe totals.
Return explicit estimated/unknown readings. Missing usage or a matching current
rate cannot turn into zero. Cache counts remain observations; if usage omits the
cache split, a conservative all-uncached estimate is labeled accordingly.

Usage names must distinguish cache misses from cache writes. Migrate internal
`cacheWriteInput` callers to `cacheMissInput`; do not invent missing fields. Unit
AC: hand-calculated $0.000113 case; missing usage/rate; cache inconsistency; unknown
cache split; effective/expired/model-mismatched rate; immutable history after
catalog edits; conservative full-context/output reservation. Runtime budget
wiring and the final supported ceiling policy remain the following units.

### Synthesis Decision

Choose A. Parent and independent cross-judge agree: A scores 14/15, B 13/15 on
the five stated criteria. A best preserves event authority and a small awaited
interface; B is stronger at the final transport boundary. Graft that recheck,
same-trace parent validation, and explicit outage/cancellation-settlement handling.
Reject a separately mutable accounting ledger and SDK/service dependency because
neither is needed to satisfy the accepted compatibility/measurement scope.

The runtime wrapper invokes the callback exactly once and awaits full stream
consumption and terminal accounting. Agent owns the guarded call site and may
not bypass it in configured production execution. The provider checks the
governed AbortSignal again immediately before fetch; it does not retry secretly.
Store start/settlement facts with unique operation IDs, full frozen rates and
typed known/partial/unknown/not-applicable readings. Projections are read-only.

Do not expand the approved budget feature into an unusable mandatory exact-billing
promise. Default preflight is a declared conservative estimate with enforced
output/turn/tool/time limits and post-call stop; missing required usage/pricing
blocks subsequent paid calls. A strict ceiling mode requires separately verified
provider limits and remains unavailable without them. UI and API must distinguish
an estimate from an invoice or guaranteed spend cap. The pure reservation helper
does not turn a supplied input estimate into a verified token bound.

The retention boundary initially prunes disposable deltas/debug records with a
receipt while protecting lifecycle, usage/prices, source/practice evidence,
idempotency and delivery records. This is bounded telemetry retention, not a claim
of bounded total DB size; capacity alarms and an explicit archival policy cover
protected growth. This tradeoff must remain visible in deployment documentation.

### Awaited Dispatch Contract

R7-A integration prerequisite, before any accounting consumer: optional Agent
`dispatch.model(call, invoke)` and `dispatch.tool(call, invoke)` own awaited
invocation/settlement. Existing CLI/TUI without policy preserve behavior. Model
callback consumes the entire stream; tool callback contains argument validation
and execution. Each callback can execute at most once. Upstream cancellation
cannot be replaced by a policy-supplied signal. Output token overrides can only
lower a provider factory cap, and DeepSeek rechecks abort just before fetch.

AC: rejected preflight makes zero provider calls; a delayed model settlement
blocks tools/next model; failed tool settlement blocks the next model; cancellation
while policy waits prevents dispatch; repeated callback invocation is rejected;
streaming/lifecycle order and provider error behavior remain compatible.

### Runtime Observation Facts

Add a cohesive `RuntimeTelemetry` over existing `runtime_events`, not a second
mutable accounting table. Persist one context per run (random nonzero trace/root
IDs), operation starts with validated parent references and frozen price, and one
terminal settlement per operation. Domain outcomes distinguish finished/error/
cancelled from interrupted (unknown end/duration). Usage and cost are computed
by the runtime from the recorded price, never accepted as client-written totals.

This unit's AC: empty context has no paid usage; the known pricing fixture survives
reopen; same terminal intent is idempotent while changed usage/outcome conflicts;
unadmitted/cross-run/invalid-parent settlement is rejected; injected persistence
failure rolls back; cancellation and memory clear block starts but allow existing
operation settlement; interruption preserves unknown exposure. All writes remain
redacted. Production dispatch integration follows only after these checks pass.

### Content Dispatch Integration

Use one runtime dispatch policy for actual awaited model/tool calls. Each model
start freezes provider/model/rate/reservation. Settlement precedes the next tool
or model. Preserve existing tool-result audit events used by citation validation;
stream subscribers retain only text deltas, never budget authorization/accounting.
Source/browser reads are children of their tool; memory capture, final validation
and delivery record real boundaries. Worker recovery settles open operations as
interrupted in the same transaction as the failed/cancelled run, without retry.

Add optional frozen task limits `maxCostUsd` and `maxTotalTokens`. Preflight uses
the explicitly named `utf8_bytes_plus_message_overhead_v1` input heuristic plus
the enforced maximum output, not a claimed tokenizer/provider upper bound. It
reserves against settled cost/tokens, then reconciles reported usage before
advancement. Required missing usage/pricing or an exceeded budget fails closed.
No cost budget preserves existing no-catalog operation with unknown estimated
cost; an explicit demo never enters paid accounting. `AGENT_PRICE_CATALOG` is a
bounded JSON configuration parsed by the runtime, shared by API and terminal.
An empty default invents no current model prices. Operators supply dated rates.

Preserve original stop-or-degrade scope with explicit `onBudgetOverflow`:
default `stop`; opt-in `extractive` may deliver deterministic excerpts only after
all sources have been attempted and persisted tool evidence is available. It
must not make another model/source request, bypass citation/practice checks, or
recover from cancellation, deadline, unknown accounting or persistence failure.
Record the specific budget reason and degraded completion. A preflight denial
before collection cannot produce a fabricated fallback digest.

Unit AC: count actual sends/tool invocations for preflight and postflight denials;
missing usage is unknown, output override is propagated, rate revision cannot
rewrite prior settlements, cancellation retains usage while blocking further
work, source failures have failed spans, tool/source parentage is correct, and
recovery records unknown exposure without another model request. Run existing
R4/R5/R6 regressions before projection/UI integration. These are controlled
provider tests, not live billing or cloud acceptance.

### Projection And Export Unit

Replace event-name-derived spans and payload sums with observation facts. Keep
unobserved legacy history explicitly unknown; never backfill invented paid calls.
Run accounting exposes complete/partial/unknown/not-applicable status, with known
subtotals separate from nullable totals. Demo has no paid cost/usage. Snapshot
selects an executing/cancelling run before a newer queued run. Empty database has
no passed eval, secret scan or sandbox assertion.

Metrics use a trailing 24-hour live-only population ending at snapshot time.
Run latency samples come only from terminal run duration, tool/model samples
from finished observations, including measured zero. Use nearest-rank quantiles,
explicit sample counts and separate populations; no samples means null. Success
and error rates use completed/failed/cancelled terminal runs; skipped and queued
runs do not enter the denominator. Eval rate covers stored latest non-skipped
reports and explicitly has a different scope. Window cost/usage comes from paid
operations settled in that window, plus active unknown exposures admitted there.

Expose bounded historical run trace and OTLP JSON-compatible export without
prompt/tool contents. Unfinished/interrupted spans have no fabricated end time;
omit them from OTLP with explicit export diagnostics. No collector is installed.
Update Dashboard numeric/trace consumers to render unknown, partial and demo
states directly rather than converting null to zero. Remove hardcoded demo
duration/token/cost output and the obsolete simulated budget implementation;
its stop/degrade coverage is replaced by real-dispatch tests above.

AC: empty/demo truthfulness; hand samples [0,10,20,100] => p50 10/p95 100;
separate tool samples [1,3,7] => p50 3/p95 7; out-of-window/demo exclusion;
known+missing usage yields partial rather than understated totals; valid IDs and
parents in actual trace/export; no fake LLM span for extractive demo; active run
remains visible behind queued work. Re-run API/UI consumers and eval harness.

## Acceptance Matrix

| AC | Required observable evidence |
| --- | --- |
| R7.1 | No-model/demo runs have no paid-model usage; actual usage matches provider fields, including cache counts. Unknown/missing/partial usage or pricing is explicit. A price-config revision cannot rewrite historical costs. |
| R7.2 | Every actual model/tool operation has measured start/end/status; source failures and cancellation are not successful spans. Root/child IDs meet OTel lengths and parent linkage; interrupted work remains distinguishable. Run and tool latency windows have separate sample counts and p50/p95. |
| R7.3 | Empty SQLite has no default passed eval, measured zero latency or asserted sandbox. Current security posture describes verified configuration, not assumed isolation. Production metrics exclude explicit demo runs. |
| R7.4 | Low-budget preflight prevents dispatch; exceeded or unknown required accounting blocks later paid calls; deadline abort reaches actual provider/source/browser. Failure/degradation and already incurred or unknown cost remain inspectable. No promise of reversing remote work or exact provider billing. |
| R7.5 | Default heartbeat 30s/stale 90s with validated config. Stopping updates yields stale, recovery yields fresh; readiness returns 503 for failed dependencies/worker while liveness stays distinct. Health reads never seed demo. Ownership remains the existing process-held lock. |
| R7.6 | Error/worker alerts record deduplicated open/recovery transitions, source/severity/run evidence and redacted logs. Retention is explicit and bounded, preserves protected unfinished work and referenced evidence, and does not silently invalidate practice/idempotency/delivery contracts. |

Manual acceptance: inspect measured model/tool operations and unknown states in
the running Dashboard; trigger a low-budget task and count actual dispatches;
stop heartbeat without granting another owner, observe readiness/stale, recover;
restart and compare persisted usage/prices/alerts. Use actual Chromium/processes
with controlled fixtures, then a separately labeled bounded live-provider check.

### Budget And Accounting Constraints

Preflight must be awaited before provider dispatch; terminal accounting must be
persisted before the loop can make another paid call. A failed write blocks the
next dispatch. An initiated request with no final usage is unknown exposure, not
a released zero-cost reservation. A rejected preflight is a denied attempt, not
a paid model invocation. Invocation identity prevents duplicate terminal events
from counting usage twice. User cancellation does not erase usage already returned.

Report the distinction between estimated local spend guardrails and provider
billing. Input token prediction is not an exact DeepSeek tokenizer; before-call
estimates need a named method, plus bounded output/turn/tool limits and post-call
reconciliation. No hard dollar guarantee based on text length alone. Unknown
usage/pricing must fail closed when the run requires a cost budget. Do not replay
an interrupted paid call automatically after process restart.

Existing `writeEvent` rejects `agent.*` observations after cancellation or memory
epoch fencing. The new settlement path must still accept accounting for an
already-admitted invocation after that fence, without permitting another dispatch
or result delivery. Validate the invocation reference and one terminal receipt;
do not broadly disable the execution fence to let telemetry through.

Retention must not erase the only evidence that prevents request re-admission,
duplicate delivery or unauthorized practice activation. Keep compact durable
receipts/accounting and pin referenced evidence, or reject the purge. Pruning is
an explicit policy action with counts and audit, not a side effect of snapshot
reads. Historical retention limits are not a secure-erasure promise for backups.

### Independent Test Oracles

Use hand-calculated fixtures rather than asking the production projector for its
own expected answer. Synthetic rates of $1/million uncached input, $0.10/million
cached input and $2/million output give $0.000113 for 100 input (30 cached) and
20 output tokens. Change the configured rate after settlement and assert the
stored estimate remains unchanged. Unknown usage is not zero. Two identical
terminal observations for one invocation cannot double the result.

For a declared nearest-rank percentile method, run samples [0, 10, 20, 100] give
p50=10 and p95=100; separate tool samples [1, 3, 7] give p50=3 and p95=7. Include
measured zero, exclude absent duration and out-of-window samples, and assert each
sample count. Population/status rules must be documented with the chosen shape.

Abort tests count actual provider dispatches and observe transport signals, not
just an error event. Persistence tests kill/restart a separate process mid-call
and ensure the unknown exposure remains and the call is not automatically retried.
Heartbeat tests use an injected clock for thresholds and a real process check for
restart; a paused updater must not be simulated merely by editing the UI response.

## Sources And Constraints

- [OpenTelemetry Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/):
  use valid nonzero trace/span identifiers, real lifecycle timestamps and parent
  relationships. Operation failure is not inferred only from log severity.
- [GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai):
  upstream has moved; pin the implemented attribute schema rather than claiming
  an unversioned evolving standard. Compatibility shape is not an installed
  collector or verified external tracing service.
- [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/):
  use returned token counts and cache details. Interrupted streams can miss final
  usage, which stays unknown. Existing stream/output limits remain enforced.
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), checked
  2026-11-02: rates depend on model, cached input and peak/off-peak timing. Use an
  explicit versioned rate policy and label calculated cost as an estimate;
  do not silently select a holiday calendar or treat it as the provider invoice.
- [Readiness and liveness](https://kubernetes.io/docs/concepts/workloads/pods/probes/):
  separate traffic readiness from process survival. This informs semantics and
  does not add Kubernetes to the deployment stack.
- [Prometheus alerting practices](https://prometheus.io/docs/practices/alerting/):
  use actionable symptoms and transition deduplication. A local in-process alert
  cannot detect its own total outage; R10 must verify an external health monitor.

## Evidence

Baseline command executed against R6 built code with a new in-memory SQLite,
then explicit `runDemoAgent` with no model provider or network. Output preserved
at `/private/tmp/agent-r7-baseline-projections.log`: empty state reports success
rate 1, eval pass rate 1, four passed gates, sandbox enabled, scan passed and a
fabricated denial. The no-model demo reports 2,380 input / 640 output tokens,
$0.0029 and 420ms source span despite a roughly 15ms whole run. This is a recorded
failure baseline, not acceptable behavior. No R7 AC is marked passed yet.

The provider-only prerequisite is verified: both new R7 cache-accounting tests
failed first (`/private/tmp/agent-r7-usage-baseline.log`). Parsing now rejects
contradictory/oversized cache counts and supports the nested documented field.
All AI tests pass (`/private/tmp/agent-r7-usage-tests.log`), and TypeScript check
passes. This small boundary repair does not close R7-A or change the pending
runtime architecture decision.

Pricing prerequisite: 14 focused provider/pricing tests passed, check/build and
diff whitespace checks passed (`/private/tmp/agent-r7-pricing-tests.log`). The
hand oracle returns 113,000 nanodollars; replacing the catalog does not alter the
frozen rate. The legacy cache-miss field name has no remaining source callers.
R4 controlled API/Chromium workflow passed after provider parsing changes
(`/private/tmp/agent-r7-provider-r4-regression.log`). Runtime measurement and
budget integration remain unverified; R7-A is not yet accepted.

Awaited dispatch prerequisite: the preflight test first failed because the old
Agent ignored the policy; the settlement test waited indefinitely for a missing
hook (`/private/tmp/agent-r7-dispatch-baseline.log`). The known test process was
terminated and a 5s test deadline added. Production wrappers now await full model
consumption/tool execution and settlement, allow one invocation, combine signals,
and propagate lower output caps. DeepSeek checks cancellation just before fetch.
28 focused Agent/provider tests pass (`/private/tmp/agent-r7-dispatch-final.log`),
including actual send-count zero after deferred preparation cancellation.
Check and build pass. No runtime consumer is connected yet, so this is not a
claim that production cost budgets or telemetry have been accepted.

Full regression after these prerequisites: 274 total, 272 reported pass, 2 skipped,
0 failures (`/private/tmp/agent-r7-prerequisites-full.log`). The inherited keyless
live-smoke reporting issue remains R9. No new R7 commit has been made; runtime
still has the documented old metric projection until the next integration unit.

Next implementation unit: event-authoritative runtime observation context and
started/settled/denied operation facts, validated parent IDs and one terminal
receipt; settlement remains writable after cancellation only for an admitted
operation. Use the verified Agent wrapper for full stream consumption before
advancement, not existing subscribers. Freeze price at admission, preserve unknown
exposure, and test duplicate/conflicting settlement and failure rollback before
wiring the API/UI projection. Extend the explicit plan/AC before each unit.

### Runtime Integration And Projection Evidence

Observation facts and pricing: 10 focused tests passed in
`/private/tmp/agent-r7-facts-tests.log`, including rollback, cross-run rejection,
idempotent settlement, cancellation/clear fences and persisted price snapshots.
The first check found a test's unparsed SQLite row; it was corrected without
loosening production types. Real-dispatch/R4/facts tests then passed 31/31 in
`/private/tmp/agent-r7-content-observability.log`. Extractive fallback and R4
regressions passed 27/27 in `/private/tmp/agent-r7-budget-fallback.log`.

Actual controlled provider requests now settle before advancement. Budget tests
count transport calls; low cost/token budget or missing required price sends zero,
overrun/unknown required usage stops later work, and deadline reaches the request
signal. Optional extractive degradation retains collected citations, makes no
new model request, and records its reason. Ownership recovery closes open facts
as interrupted, including terminal runs whose settlement write previously failed.

Pure projection tests use independent quantile and pricing oracles. A legacy
test failed because it expected sandbox enabled with no evidence; the assertion
now checks not-configured and a structured actual denial. The first full suite
also failed on the obsolete bundle string `P50 latency`; its build-only assertion
now uses `Run P50`. This is not behavioral acceptance and remains part of R9's
static-test replacement. Initial failures are preserved in
`/private/tmp/agent-r7-projection-tests.log`,
`/private/tmp/agent-r7-projection-full.log` and
`/private/tmp/agent-r7-projection-eval.log`.

Latest working-tree check/build/dashboard build/package-boundary/diff checks
pass. Full suite: 297 total, 295 reported pass, 2 skipped, 0 failures
(`/private/tmp/agent-r7-projection-full-final.log`). Eval: 13 total, 11 reported
pass, 2 skipped, 0 failures (`/private/tmp/agent-r7-projection-eval-final.log`).
The two inherited keyless live-smoke early-return reporting defects remain R9;
these totals do not establish live-model acceptance.

`scripts/verify-observability-ui.mjs` passed through actual API/SQLite/Dashboard
and isolated Chromium with controlled model/source responses. Final evidence:
`artifacts/acceptance/R7/observability-report.json`, desktop/mobile screenshots,
and `/private/tmp/agent-r7-observability-ui-final.log`. Two known calls cost
$0.000226 under the synthetic catalog; one known plus one missing usage produces
a null total and a $0.000113 known subtotal. A third low-budget run adds no model
or source requests. Authenticated trace download preserves parent IDs, omits
source/prompt text and has no invented unfinished endpoints. Visual inspection
caught mobile history clipping despite a passing document-width check; grid
containment and a local bounding-box assertion now cover that failure.

Final R7 UI run IDs: `run-7fee459c-1850-44ac-977f-bf278a1e44d7`,
`run-41b9f24f-53a3-4052-ae48-9be3550e9114`,
`run-29715493-9ce7-4c46-b3ec-de0be809a6de`. Reports identify base SHA
`efa9779` and dirty=true; these are not clean exact-head acceptance.

R4 actual controlled content UI, R5 scheduler UI/cancellation and R6 memory /
practice UI regressions pass after the projection changes. Logs:
`/private/tmp/agent-r7-projection-r4-final.log`,
`/private/tmp/agent-r7-projection-r5-ui.log`,
`/private/tmp/agent-r7-projection-r6-ui.log`. Earlier dispatch integration also
passed R5 process crash/restart and R6 separate CLI/API restart gates. R7 has not
been committed: remaining scheduler/security observation boundaries, heartbeat,
readiness, alerts, retention and full-batch process/live/exact-head gates remain.

### Next Unit: Monitoring And Remaining Boundaries

Before implementation, freeze detailed storage/lifecycle AC for a persisted
worker heartbeat (30s write / 90s stale), independently polled monitoring,
readiness 503, deduplicated alert open/recovery, and bounded disposable-event
retention. Use a new migration after published v7; do not change v1-v7 checksums.
The existing process-held owner lock remains authoritative. A stopped heartbeat
writer must not allow a second owner; heartbeat freshness alone grants no work.
Keep server/terminal composition shared. Reads must neither seed nor acknowledge
alerts, and whole-process failure requires R10's external monitoring.

Add actual scheduler admission and security-policy boundary spans without
fabricating them from old audit/event names or reopening terminal execution.
Keep the completed cost/usage/projector work under regression during that unit.

Monitoring architect checklist:
- [x] Ground owner lifecycle, startup/readiness and protected evidence.
- [x] Frame and compare two monitoring/storage candidates.
- [x] Cross-judge, choose and freeze usage/type sketch plus behavioral AC.
- [x] Implement and verify monitoring storage/lifecycle.
- [x] Implement and verify host/API/UI/process integration.
- [x] Reassess architecture: existing host lifecycle accommodates explicit SSE close; no ownership or evidence boundary was relaxed.

Monitoring arena checklist: frame, fan-out, cross-judge, pick, graft and behavioral
verification complete. Rubric (0-3 each): no ownership relaxation; truthful
freshness/readiness; atomic deduplicated alerts/retention protection; shared
server/terminal lifecycle with a small interface; direct failure-testability.

Grounding confirmed: owner acquisition also occurs on manual/tick paths, not only
`start()`, and terminal daemon never calls `start()`. Monitoring cannot attach only
to cron startup. Readiness currently accepts a missing/stopped owner and turns DB
failure into 500. Stop must retain ownership until active execution drains even
when cancellation persistence fails; that failure is not permission to release
a live worker. Protected terminal history includes run requests/jobs, lifecycle,
all observation facts, frozen task/source/memory context, tool citation evidence,
delivery receipts, approvals, feedback and immutable practices. Foreign keys do
not describe all these dependencies. Candidate sketches use the saved read-only
grounding at `/private/tmp/agent-r7d-grounding.md`.

While candidates compare monitoring ownership, verify the disjoint remaining-span
unit: actual scheduler enqueue begins/ends inside its existing admission
transaction; skip is a scheduling decision, not a model call. A real configured
source-binding security check gets a child span under the tool; a denied source
is denied, not successful. No spans are inferred from old audit names and no
post-terminal execution fences are relaxed. AC: valid trace parentage; no
duplicate enqueue on idempotent retries; admission rollback leaves no span/job;
denied source makes zero source requests and records a denied security span.

Grounding exposed a shutdown prerequisite: a cancellation-event write failure
currently skips abort/drain, and a rejected drained completion skips release.
Preserve the first failure while always aborting and awaiting the actual active
completion; release only after that promise settles, never on a timeout. AC:
inject cancellation persistence failure, observe abort, keep a second worker
refused while teardown is delayed, then release ownership after teardown and
surface the original persistence failure. Monitoring must build on this rule.

### R7-D Storage And Lifecycle Contract

Selection: compact operational state plus immutable alert transitions
(candidate A). Independent cross-judge agrees (A 15/15, B 12/15); the parent's
rubric also favors A's concrete polling deadline and borrowed-store lifecycle.
Graft B's pure three-valued condition evaluator and transition provenance (rule
version, evaluation time and evidence watermark). Candidate B's
separate retention module is retained so destructive maintenance has one narrow
entry point. Heartbeat history is not an append-every-tick journal. Neither
design changes the existing SQLite ownership lock or canonical runtime facts.

Usage: both adapters compose `createTaskRuntime({ runtime, env, ... })`, use its
existing scheduler commands and `monitoring.read()/alerts()`, and await `close()`
before closing the borrowed database. Scheduler acquisition binds the monitor
after recovery on every ownership path, including manual/tick. Monitoring has
separate heartbeat and condition-poll timers. Internal injected timer/clock
adapters support fault harnesses, not public pause/debug HTTP endpoints.

Append migration v8 with two fixed operational rows (worker and poll), current
condition heads, append-only transitions, and idempotent prune receipts. Existing
v1-v7 statements/checksums stay unchanged. A worker sample includes owner session,
phase, active run ID and observed time. Health requires this process's held lock,
ready phase, matching fresh worker sample and timely monitor progress. Reads do
not write. Missing/disabled/unowned/stopped/faulted/DB-unavailable is unready.
Unknown/future timestamps are not fresh. Default write/stale/poll/overdue intervals
are 30s/90s/5s/15s; validated configuration preserves their ordering.

Faults latch dispatch off, abort active work and retain ownership until actual
drain; stop is idempotent even when persistence fails. Stale observations also
fence this owner. Resuming a paused writer recovers freshness and the stale alert,
but the owner must be restarted after drain before accepting more work. The UI
must distinguish fresh heartbeat from dispatch readiness. Liveness only proves
HTTP responsiveness. Whole-process outage still requires R10 external monitoring.

Each independent poll atomically updates condition state and inserts only
open/recovery edges with unique condition/generation/edge identity. Unknown samples
never clear an alert. Initial rules: heartbeat stale, worker fault, and at least
three distinct canonical `run.failed` events in the half-open five-minute window
`(now - window, now]`, regardless of auxiliary error events. Persisted edges survive restart; polling and
reading do not duplicate notifications. Persistence failures log redacted codes;
an unavailable database cannot provide durable alert delivery.

Explicit operator pruning accepts actor-scoped request identity, cutoff, cursor
and a bounded batch (default 500, max 5000 examined). Only schema-valid
`agent.output.delta` belonging to positively terminal runs older than cutoff is
eligible; pending jobs/open observations and referenced eval/practice evidence
remain protected. Receipt intent, deleted-ID digest and cursor commit atomically
with deletion. Same request replays its receipt; changed intent conflicts. No
automatic pruning, cascading deletion, sequence rewrite or total-size guarantee.

Unit AC before host integration:
- v7 upgrade/reopen preserves prior checksums and evidence; v8 failure rolls back.
- manual, tick and start bind one writer/poller; stop drains before disposal/release.
- paused writer becomes stale, independently opens once, resumes fresh/recovery
  once; another owner is refused throughout and a fenced owner cannot dispatch.
- writer/poller/settlement failures fence before another queued execution; shutdown
  cancellation failure still aborts/drains and preserves its original error.
- read floods do not mutate; future/rollback clock, missing worker and DB failure
  cannot appear ready; alert transaction failure leaves no partial edge/head.
- pruning bounds, idempotency, rollback and protected-record hashes hold.

Host/API/UI/process AC follows this verified unit; entire R7 remains unaccepted.

### R7-D Host Integration Contract

Storage/lifecycle checks passed before host integration: 30/30 in
`/private/tmp/agent-r7d-storage-lifecycle.log`; prior monitoring and retention
gates passed 26/26 and 3/3 respectively. This is controlled in-process evidence,
not the pending separate-process pause/recovery scenario. Type checking passed.

Next: wire shared task-runtime composition into server/local host; validated
environment intervals; read-only `/readyz` returning 503 for missing/faulted or
unavailable worker; authenticated monitoring health/alert pages. Register close
before startup and drain/close on registration or listen failure. Preserve
healthz as liveness only. Existing API-only tests must explicitly expect absent
worker readiness failure, not silently start a worker from a GET.

Retention is a high-risk operator command through the existing server approval
executor (`telemetry_prune`), not an unauthenticated cleanup endpoint. Its schema,
actor-scoped receipt and bounded predicate remain runtime-owned. Viewer/missing
approval/CSRF rejection must leave output deltas intact.

AC: environment rejects invalid intervals; server and terminal use the same
monitor lifecycle; readiness 200 only while locally owned and healthy, 503 when
disabled/stale/faulted/DB unavailable; GETs leave tables unchanged. Real process
heartbeat pause/resume retains lock and persists one open/recovery transition;
old owner stays fenced until orderly restart. Authenticated Dashboard displays
health and alerts with desktop/mobile containment. Approved pruning deletes only
eligible deltas and presents its receipt. Startup/listen errors leave no owner,
database connection or recurring timers behind.

First process/UI gate failed at graceful stop with the Dashboard still connected:
`/private/tmp/agent-r7d-monitoring-process-ui.log` and the timestamped failure
artifact preserve it. Fastify's installed `preClose`/`onClose` contract confirms
that an open SSE response prevents `onClose` from running. Narrow correction AC:
preClose fences/drains the worker and ends registered SSE streams; pending stream
reads settle before database closure; repeated polling does not overlap; the real
browser stays connected during stop and the child exits cleanly. R8's incremental
events/reconnect-cursor work is not being pulled into this fix.

### Live Accounting Gate Contract

Add an explicitly opt-in R7 script, bounded to three DeepSeek turns, two tool
calls and 1024 output tokens per turn. The source is controlled HTML to separate
provider accounting from public-site availability. Independently parse a cloned
wire SSE response into model/usage-only evidence; do not store wire text, prompts
or credentials. Compare input/output/total/cache counts against each persisted
LLM settlement, exact call count, actual tool/source spans and final result.
Missing key is skipped with exit 2, not passed; a failed attempt keeps its report.
No rate catalog is supplied: recorded cost must be unknown, never zero or a
synthetic-price invoice. Hand-priced cost accuracy remains the controlled gate.
This does not replace R4 public-source or R9 model-quality eval requirements.

Final AC audit found two evidence gaps before commit. Alert transitions must also
include source/severity and bounded associated run IDs, not only a watermark.
The existing R5 SIGKILL fixture pauses before the provider, so it cannot close
R7's mid-call exposure criterion. Add a separate fixture that enters the actual
provider dispatch then waits without returning usage; kill that process, acquire
with a new worker, and assert interrupted/unknown settlement, frozen original
price, failed run, same-key idempotency and zero new provider dispatches. This is
controlled transport, not a paid request. Run before declaring R7-E verified.

## Pre-Commit Acceptance

Environment: macOS arm64, bundled Node 24.22.1, SQLite and actual headless
Chromium. All reports still identify base `efa9779` with dirty=true. These are
working-tree acceptance, not clean exact-head release evidence.

| AC | Observed result |
| --- | --- |
| R7.1 | Pricing/fact tests use an independent arithmetic oracle. Live run `run-15f74d41-8aec-4015-b6cb-66d7d1081e26` made two real DeepSeek calls; cloned wire usage exactly matches persisted input/output/total/cache counts. Inputs 715/973, outputs 38/101, cache hits 0/640. Cost is unknown without a catalog, not zero. |
| R7.2 | Actual scheduler/security/source/browser/model/memory/eval/delivery spans have valid parents and measured boundaries. Known/partial traces download in Chromium. SIGKILL run `run-81d81ab9-5e25-49d5-a357-13a09b61e250` retains its original frozen price and interrupted unknown exposure without invented duration or retry. |
| R7.3 | Empty-state API/UI tests show no samples, no eval pass, not-run scan and unconfigured sandbox. Demo calls never enter paid metrics. |
| R7.4 | Controlled UI hand total is $0.000226; one missing usage produces unknown total plus $0.000113 subtotal. Low budget adds zero provider/source calls. Transport abort, post-call enforcement and opt-in extractive degradation pass. |
| R7.5 | Actual child process pauses only its writer; independent poll advances, stale opens once, readiness is 503 and liveness 200. A second owner is refused. Resume is fresh but fenced; graceful replacement is ready with a different session. |
| R7.6 | Alerts persist source/severity, rule/session/watermark and at most 20 run IDs with explicit truncation. Alert/prune rollback and idempotency pass. Chromium performs bound approval then deletes exactly one eligible delta; canonical event hash is unchanged. Viewer/no-CSRF/no-approval are denied. |

Key logs and artifacts:
- `/private/tmp/agent-r7-alert-provenance.log`: 17 focused monitoring/API tests pass, including real open-SSE shutdown and executable port-conflict cleanup.
- `/private/tmp/agent-r7d-storage-lifecycle.log`: 30 storage/lifecycle/migration tests passed before host integration; v1-v7 checksums/statements remain unchanged.
- `/private/tmp/agent-r7d-monitoring-process-ui-final.log`: actual process/HTTP/Chromium gate passed; `artifacts/acceptance/R7/monitoring-report.json` and desktop/mobile screenshots.
- `/private/tmp/agent-r7-accounting-process-first.log`: actual mid-provider SIGKILL/restart passed; `artifacts/acceptance/R7/accounting-process-report.json`.
- `/private/tmp/agent-r7-live-usage-first.log`: bounded live provider/wire comparison passed; `artifacts/acceptance/R7/live-observability-run-15f74d41-8aec-4015-b6cb-66d7d1081e26.json`.
- `/private/tmp/agent-r7d-observability-ui-final.log`: known/partial/budget-denied runs `run-a91527c2-a56c-417a-9fab-db46d84506e6`, `run-ea68deed-a7a0-4318-8838-861e2b3cbbf3`, `run-c572fa38-a3d5-46d4-8789-28d4ab701f0e`.
- R2 auth, R4 content, R5 scheduler and R6 memory/practice browser regressions pass in `/private/tmp/agent-r7d-{auth,content,scheduler,memory}-ui-final.log`. R5/R6 separate-process regressions also pass in the corresponding `*-process-final.log` files.
- Before the final bounded-alert-evidence test, the full suite was 318 total / 316 reported pass / 2 skipped / 0 failed; eval was 13 / 11 / 2 / 0. Final frozen-tree counts will be recorded below.

First failures are retained, not overwritten: the initial process/UI stop hung
on a real SSE connection; the next attempt wrongly assumed restart erased an
authenticated session. The preClose drain/stream regression and session-aware
browser harness address those distinct causes. No failure was relabeled passed.

Limits remain explicit: same-process monitoring cannot detect total host death;
external uptime/capacity monitoring and deployment are R10. Prices are operator
supplied estimates, not invoices. Retention only bounds an explicit disposable
batch, not total DB size or secure erase. R9 still owns the two inherited
keyless-live early-return reporting defects and static-word test replacement.

Frozen-tree gate: `npm run check`, `npm run dashboard:build` (including backend
build), package boundaries and diff whitespace checks pass. Full suite is
319 total / 317 reported pass / 2 skipped / 0 failed; eval is 13 / 11 / 2 / 0.
Logs: `/private/tmp/agent-r7-precommit-{check,build,tests,eval}.log`.
The next step is an independent R7 commit, clean exact-head reruns of these gates
and actual browser/process/live evidence, then push and remote SHA comparison.
