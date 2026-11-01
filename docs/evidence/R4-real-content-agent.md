# R4: Real Content Agent

Status: accepted and pushed as `1a5d677c16ede4ed2e9f59eb37dcff74f4e17f66`; clean exact-head full-suite, actual UI/Chromium and live DeepSeek/public-source checks passed. The checkpoint is recorded in R5 evidence. Baseline: `dd6be3be97fe42a874c269d711f5ef26c92c0518`.

R3 checkpoint: pushed to `fix/agent-ops-acceptance`; remote SHA matched the baseline above. `artifacts/acceptance/R3/report.json` records a clean exact-head browser/process-restart check at 2026-11-01T03:02:35.355Z. Three runs retained six per-run results and two unique deliveries, with delivered/no_new_items/no_new_items outcomes. This is demo persistence evidence, not live-model evidence.

## Work Plan

- [x] Ground existing provider, Agent loop, runtime admission/completion and server paths.
- [x] Compare two execution designs and record the selected interfaces.
- [x] Add provider usage, bounded output, invalid/truncated response and error-path regression tests; implement the provider contract.
- [x] Add durable task definitions and actual source observations through a versioned migration.
- [x] Compose the existing Agent with restricted content tools and schema/citation validation.
- [x] Route manual and scheduled work through the same executor; demo remains explicitly selected and labeled.
- [x] Add minimal task/source configuration and inspectable real execution in Dashboard; retain full R8 UI scope.
- [x] Verify controlled provider, parser/network/browser failures, and CLI/TUI regressions.
- [x] Verify a bounded real DeepSeek request, a public content source and real browser collection, with redacted evidence.
- [x] Run full gates, record limitations, commit, rerun relevant exact-head checks, push and verify remote SHA.

## Current Architecture and Changes

At the baseline, the API admitted a request via SQLite and delegated to `RuntimeScheduler.runNow`, whose default reached `runDemoAgent`. The provider dropped usage and treated abnormal finish reasons as success. R4 now composes the existing Agent with guarded source tools, preserves validated usage and rejects abnormal completion. `commitContentRun` still owns the atomic result/inbox/terminal boundary, with additional current-run citation validation. Demo now requires explicit selection.

File ownership: `ai` owns validated DeepSeek responses and measured usage; `agent` owns turn/tool-call bounds; `runtime` owns task schemas, collection, source observations, final citation validation and execution; `db` owns migrations; `server` injects trusted provider/network configuration and enforces auth; `dashboard` edits non-secret task configuration. No cloud path imports coding-agent shell/file tools.

Provider interface adds `maxOutputTokens` and JSON response format configuration, retaining existing defaults for CLI/TUI compatibility. Actual usage stays optional when the provider omits it: missing is not zero. Abnormal finish reasons are errors, including output truncation. HTTP errors carry a bounded classification/retryability rather than raw upstream response bodies. The executor owns retry policy; no silent automatic retry hides the first failure.

Source collection must use the R2 SafeNetwork and read-only browser boundary. RSS/Atom uses `rss-parser.parseString` after the guarded fetch, not its unrestricted URL helper. HTML uses Mozilla Readability with jsdom scripts/resources disabled, returning plain text only. Original URLs, bounded content snapshots, hashes and exact evidence quotes are associated with the current run. Source IDs are configured server-side; model arguments cannot expand the network allowlist or choose an arbitrary shell command.

Limits must bound sources, source bytes/documents, tool calls, model turns, generated tokens and source/run deadlines. A successful source returning no items differs from an unavailable source. Partial source failure must be recorded as degraded; all-source failure cannot complete as successful. Content validation rejects invented document IDs/URLs/quotes and duplicate final references before atomic completion.

## Acceptance Matrix

Design synthesis: choose model-directed `collect_source(sourceId)` over deterministic precollection plus `inspect_evidence`. Both reuse one runner and R3 completion; the chosen design directly exposes the requested agent/browser tool behavior. Its additional cost and omission risk are accepted only with a hard all-configured-sources-attempted gate, per-source outcome caching, bounded calls, immutable redacted observations and exact citation validation. Borrow the alternative's frozen evidence and independent adapter-failure tests. Two read-only design candidates and an independent cross-check were completed; only the selected strategy was implemented.

Caller contract: `saveContentTask(definition, expectedRevision)` stores task settings; `admitContentRun(actor, key, taskId, trigger)` freezes the task revision in the same transaction as admission; `executeContentRun(runId, providerFactory, signal)` owns source tools, validated output and completion. Both manual and scheduled callers invoke that executor. Persist observations before returning them to the model, and validate citation membership again inside the result transaction. Missing source attempts and all-source failures fail; a successful empty source is not a fetch failure. Source URLs come from frozen configuration, never model-supplied arbitrary URLs.

| AC | Required proof |
| --- | --- |
| R4.1 | Controlled provider sees actual user/system input, emits real tool requests, receives actual tool results, produces validated final output; malformed output, unknown source/tool and provider failure produce failed runs without delivery. |
| R4.2 | Opt-in DeepSeek run stores actual response/model/usage and bounded request metadata. Missing/invalid key and upstream failure never fall back to demo. Live absence is skipped/unverified, not passed. |
| R4.3 | Public RSS/URL content and actual Chromium collection each appear in tool results and cited final output. A changed fixture page produces correspondingly changed observed content. |
| R4.4 | Every result has source, URL, summary, reason, score and evidence linked to documents read in that run. Unknown, previous-run or nonmatching quotes are rejected. |
| R4.5 | RSS, URL and browser timeout; partial and all-source failure; tool/turn/output limits; CLI/TUI streaming and tool calling regression gates. |

Manual acceptance: authenticated operator configures a task and RSS/URL source, runs it, checks cited text against the actual source, inspects tool requests/results and measured model usage, then repeats with an invalid source to inspect the failure. Browser and live-model checks use separate evidence labels. Tests use isolated databases and synthetic secrets; live runs never expose the existing `.env` or its key.

## Reference Verification

- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/): `max_tokens`, JSON output requiring an explicit JSON instruction, streamed usage and finish reasons. Current docs describe usage on the final choice chunk; the adapter will also accept usage-only chunks for compatibility.
- [rss-parser](https://github.com/rbren/rss-parser): parse guarded response strings, including RSS/Atom.
- [Mozilla Readability](https://github.com/mozilla/readability/blob/main/README.md) and [jsdom security](https://github.com/jsdom/jsdom/security): do not enable scripts or remote resource loading; Readability is not an HTML sanitizer, so only extracted text enters tool responses.

Official npm metadata checked 2026-11-01: rss-parser 3.13.0, @mozilla/readability 0.6.0, jsdom 30.1.3. jsdom supports the pinned Node 22.23.4 runtime. Versions are not installed or accepted merely by appearing here.

- [Cloudflare DNS JSON API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/): explicit optional resolver, fixed HTTPS endpoint and bounded validated responses. `AGENT_DNS_MODE=system` remains the default. Selecting `cloudflare` sends source DNS queries to Cloudflare; it is never an automatic fallback. All resolved addresses still pass the same public-address validation and pinned HTTP transport.

## Evidence

Provider baseline: six new checks failed (missing usage/limits, abnormal finish and incomplete stream reported success, malformed usage accepted, unclassified/raw HTTP errors). The byte-cap test exposed an indefinitely open response; the exact test process was stopped and a one-second test deadline added. After implementation, provider contract plus existing provider tests passed (16 tests); the additional truncated-tool-JSON test and agent budget regression then passed together with the existing agent cases (19 tests). This does not close R4.1/R4.2 by itself.

Source adapter tests: nine passed, covering HTML script removal/redaction/hash, real RSS/Atom parsing and feed-versus-article provenance, empty/malformed/HTTP/policy distinctions, all three adapter deadlines, current-document citations, browser result projection and conservative similarity merging. Browser timeout in this unit matrix uses an injected abort-aware adapter. Actual Chromium is covered separately below.

Dependency inspection found high advisories in `source-map-js` and development-only Vite. Compatible updates were applied, including Vite 8.3.5. The final official-registry production audit reports three moderate affected packages, zero high and zero critical (exit 1, not a clean audit). The remaining Fastify/static-chain exposure analysis is in R2. Reaudit at release.

### Observed Acceptance

| AC | Observed evidence |
| --- | --- |
| R4.1 | Runtime's 13 content-agent tests cover tool transcripts, cache, output/citation errors, provider failure, unknown source, frozen task revisions, persistence faults and rollback. Server tests verify missing task/key fails without demo fallback and manual/scheduled execution share the same runner. |
| R4.2 | Live run `run-ac268d5c-e1df-428f-b2bc-902d6e36e7c8` completed with DeepSeek: two calls, usage 609/72/681 and 1670/350/2020 (input/output/total), total 2,701 tokens. Cache usage is retained; no invented dollar cost is claimed. |
| R4.3 | The same live run collected public Rust RSS and Example Domain through real Chromium. Controlled Dashboard verification uses a new UUID in page text and asserts that exact value in observed tool output and final content. |
| R4.4 | Immutable source text, hash, read URL, document ID and exact quotes are checked before and inside completion. An RSS article link is distinguished from the feed actually read. Cross-run/unknown/unreturned evidence and mismatched quotes are rejected. |
| R4.5 | RSS/URL/browser deadline and partial/all-failure cases pass (injected browser for the error matrix). Full suite: 219 tests, 217 reported pass, 2 skip, 0 fail. Existing CLI/TUI streaming, tool and abort regressions pass. Real browser security regression is a separate gate. |

Controlled UI verification uses actual API, SQLite, desktop 1440px/mobile 390px and actual Chromium with a controlled provider/transport. It creates a browser-source task, runs it, checks a fresh nonce, inspects execution details, follows the source-link contract and verifies no page overflow. Screenshots and report are under `artifacts/acceptance/R4/`; this is not live-model evidence.

The first real provider attempt, `run-7beefcf3-2451-4ee3-8c8a-ff480108fff3`, failed because system DNS returned reserved fake-IP addresses. Policy correctly denied both sources and no items were delivered. It consumed 1,474 actual tokens. The failure report is retained. An explicitly configured Cloudflare resolver returned public addresses and the subsequent bounded live run passed. Host DNS, source allowlists and SSRF rejection rules were not weakened. The existing `.env` was neither printed nor modified.

The first controlled browser run also exposed a strict-schema bug: browser-only `links`/`blockedRequests` leaked into an observed document. Explicit field projection fixed it and a regression test was added. `controlled-failed-run-536e5658-9631-4403-abc2-3ebe84808e8e.json` preserves that failure.

These pre-commit reports record baseline SHA `dd6be3b` with `dirty: true`, not an immutable release. Gates run with bundled Node 24.19 on macOS ARM64; build/check/package boundaries/dashboard/full suite/eval returned 0. R3's actual process-restart/browser regression passed again at 2026-11-01T03:36:32.530Z. Exact-head reports must be rerun after the independent R4 commit before proceeding to R5.

### Remaining Boundaries

Two old keyless DeepSeek smoke tests return early and are counted as passed by the default suite. They are not live evidence; R9 must fix explicit skip reporting. Citation matching proves provenance, not semantic entailment. Manual inspection of the live summaries matched the observed Rust funding article and Example Domain page, but does not establish broad model quality. The task UI is minimal; full editing/navigation is R8. Durable scheduling/cancellation is R5, preferences/practices R6, actual pricing/traces/heartbeat R7, mutation/eval lineage R9, and cloud/container release acceptance R10. R4 is not a production-ready declaration.
