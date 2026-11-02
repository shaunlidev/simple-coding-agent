# Runtime Observability

## Accounting

Paid usage comes from the provider's reported input/output/cache counts. Missing
usage stays unknown. Cost is an estimate from the price snapshot stored before
each call, not a provider invoice. Historical calls never adopt a later rate.
Demo/extractive-only execution has no paid-model usage or estimated model cost.

`AGENT_PRICE_CATALOG` defaults to `[]`. API and local terminal parse the same
bounded JSON array. Each entry requires:

| Field | Value |
| --- | --- |
| `provider`, `model` | Exact provider and requested model identifiers |
| `version` | Operator-assigned immutable rate revision |
| `source` | URL of the verified pricing source |
| `checkedAt` | ISO UTC time the rate was verified |
| `validFrom`, `validUntil` | ISO UTC validity interval, end exclusive |
| `inputMicrousdPerMillion` | Integer micro-USD per million uncached input tokens |
| `cachedInputMicrousdPerMillion` | Integer micro-USD per million cached input tokens |
| `outputMicrousdPerMillion` | Integer micro-USD per million output tokens |

For units only, $1 per million tokens is 1,000,000 micro-USD per million. This is
not a current model price. Supply verified model-specific rates and an explicit
policy for variable pricing. The runtime does not infer peak/off-peak holidays.
An absent, expired or mismatched rate remains unknown. Response-model mismatch
also prevents a confident cost estimate. Missing cache split uses the maximum
configured input rate and labels that basis.

## Limits

Task limits are frozen at admission. Optional `maxCostUsd` and `maxTotalTokens`
gate dispatch using an explicit input-size heuristic and the enforced output
cap. Usage is reconciled after the full response before later tools/model calls.
This is a conservative estimated guardrail, not an exact invoice ceiling.
Missing required accounting fails closed. An already-sent request can incur
cost even if cancelled; cancellation stops local work, not remote billing.

`onBudgetOverflow` defaults to `stop`. `extractive` allows a deterministic cited
excerpt only after all sources were attempted, using already collected evidence.
It makes no additional model request and does not bypass citation/practice
validation, cancellation, deadline, missing accounting or persistence failures.

## Metrics And Traces

Dashboard metrics use a trailing 24-hour live-only window. Run, tool and model
latencies have separate sample counts and nearest-rank p50/p95. Measured zero is
a sample; absent duration is not. Completed/failed/cancelled runs form the rate
denominator; skipped/queued runs do not. Eval rate uses latest stored non-skipped
reports, not the run window. Partial usage/cost exposes known subtotals while
keeping the total null. Legacy uninstrumented history remains unknown.

An authenticated user can inspect/download a historical trace from Run history
or `GET /api/runs/:id/trace`. Export is limited to 1,000 spans / 1 MB. The `otlp`
member is OTLP JSON-compatible trace data; the surrounding envelope includes
local measurements and omitted-span diagnostics. No collector is installed or
externally verified. Open/interrupted spans have no fabricated end timestamp.
Export excludes model prompts, tool results and source document contents.

## Worker Health

Server and terminal share the task-runtime lifecycle. Acquiring the existing
single-host SQLite ownership lock starts the heartbeat writer and an independent
condition poller, including manual/tick use without cron. A heartbeat never grants
ownership or permits takeover. The latest sample contains a worker session ID,
phase and active run; fixed operational rows avoid an append-per-heartbeat log.

| Environment variable | Default | Constraint |
| --- | --- | --- |
| `AGENT_HEARTBEAT_MS` | 30000 | Positive integer, less than stale |
| `AGENT_HEARTBEAT_STALE_MS` | 90000 | Greater than heartbeat and monitor overdue |
| `AGENT_MONITOR_POLL_MS` | 5000 | Positive integer, less than overdue |
| `AGENT_MONITOR_OVERDUE_MS` | 15000 | Less than stale |

All intervals are capped at one day. Readiness requires this process's held lock,
dispatch-capable phase, fresh matching heartbeat and recent successful monitor
polling. Wall-clock reversal/future observations are unknown; in-process deadlines
also use monotonic time. `/healthz` means HTTP responsiveness only. `/readyz`
returns 503 for an absent, stopped, stale, faulted or storage-unavailable worker;
it does not expose session/run identifiers. Authenticated `GET /api/monitoring`
contains full health and the latest 100 alert transitions. Cursor pagination is
available at `GET /api/monitoring/alerts?after=0&limit=100` (maximum 500).
Neither endpoint renews a heartbeat or acknowledges alerts.

Worker faults or overdue progress latch dispatch off and abort active work. A
resumed heartbeat can be **fresh while readiness remains false**. Drain and
restart that worker to resume dispatch. Graceful close rejects new work, closes
SSE streams, awaits active execution and only then releases ownership. A task
that ignores abort prevents release; there is no unsafe timeout takeover.

Alerts cover stale heartbeat, worker faults and three distinct failed runs in
the half-open five-minute window `(now - 5 minutes, now]`. Other error events do
not multiply the run count. Condition state and open/recovery transitions commit
atomically, deduplicated by condition/generation/edge. Unknown evidence never
recovers an alert. Transitions retain rule version, session and event watermark.
Transitions also record source/severity and up to 20 associated run IDs, with
explicit sample truncation. These are workspace alerts, not email/webhook notifications. A total
process or machine outage cannot be detected by its own poller; R10 still needs
external availability and disk-capacity monitoring.

## Output Retention

The Dashboard's Output retention command uses the existing operator/CSRF/bound
approval gate. `telemetry_prune` arguments are `key`, `before` (ISO time),
`afterSequence` (default 0) and `maxRows` (default 500, maximum 5000). Approval is
bound to an already-started run and the exact arguments; it cannot be replayed.
The runtime receipt is idempotent for the same actor/key/intent even when a fresh
approval is needed after an uncertain request outcome.

Only valid `agent.output.delta` records whose run and delta both predate cutoff
are eligible. Unfinished jobs, open observations, eval/practice references,
canonical lifecycle/accounting/source/citation evidence, approvals, receipts,
feedback and practices are retained. Examined candidates are bounded before
eligibility filtering. Deletion and its audit receipt commit together; the
receipt contains count, cursor and a hash of deleted IDs, not their output text.
Reset the cursor to zero for a later sweep of previously protected candidates.
There is no automatic deletion, secure erase, VACUUM or bounded-total-DB claim.

Controlled storage/API/process/desktop/mobile units have passed in the working
tree. Whole R7 acceptance and clean exact-head release gates remain pending;
see `docs/evidence/R7-observability-monitoring.md` for evidence and limitations.
