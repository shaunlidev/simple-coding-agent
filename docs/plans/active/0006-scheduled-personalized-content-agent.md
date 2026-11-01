# Scheduled Personalized Content Agent Plan

## Goal

Build an Option A+B local-first runtime for scheduled personalized content collection:

- Option A: local durable runtime using JSON/JSONL state under `docs/agent`.
- Option B: automation entrypoints through `run-due` and `daemon`, so cron or a long-running process can trigger the same worker.

The first production-shaped use case is a daily or every-6-hours social/content brief that can fetch a source, apply memory/preferences, rank and summarize items, create a Markdown digest, capture feedback, and make the next run more personalized.

## Practices Followed

- Harness-first acceptance: every run writes enough events and artifacts for another agent to diagnose the result without hidden chat context.
- Durable event log: scheduler triggers, fetch stages, summary, delivery, feedback, and failures are append-only JSONL records.
- Local-first memory: preferences and feedback are human-readable files before introducing vector databases or cloud services.
- Deterministic default pipeline: local tests use mock/browser fake sources and extractive summaries, so the core runtime is testable without API keys or network.
- Real scenario smoke: an opt-in live browser eval uses Playwright against a local social-style page to verify browser collection end to end.

## Storage Contract

```text
docs/agent/
  schedules/tasks.json
  events/queue.jsonl
  events/runs.jsonl
  memory/preferences.json
  memory/feedback.jsonl
  digests/YYYY-MM-DD-TASK_ID.md
```

## Feature Acceptance

### 1. Scheduler / Trigger

Acceptance criteria:

- `npm run task -- create daily-social-brief --every 6h` creates `docs/agent/schedules/tasks.json`.
- `npm run task -- run daily-social-brief` manually triggers a task immediately.
- `npm run task -- run-due` runs only tasks whose `nextRunAt` is due.
- `npm run task -- daemon --interval-ms N` loops over `run-due`; `--once` gives a deterministic harness mode.
- Successful runs update `lastRunAt` and `nextRunAt`.

### 2. Runtime Event System

Acceptance criteria:

- Every run writes append-only events to `docs/agent/events/queue.jsonl`.
- A normal run emits:
  - `task_due`
  - `fetch_started`
  - `fetch_completed`
  - `content_cleaned`
  - `content_scored`
  - `summary_created`
  - `delivery_created`
- Failures emit `run_failed` and append a failed run record.
- Every event includes `id`, `taskId`, `runId`, `type`, `createdAt`, and `payload`.

### 3. Memory / Preference System

Acceptance criteria:

- `npm run task -- preferences --interests AI,coding --blocked-topics ads` writes `docs/agent/memory/preferences.json`.
- Scoring reads interests, blocked topics, and source weights.
- Feedback is append-only in `docs/agent/memory/feedback.jsonl`.
- `saved` and `clicked` increase relevance; `dismissed` and `not_interested` reduce relevance.
- Raw feedback is preserved and never overwritten during memory updates.

### 4. Content Pipeline

Acceptance criteria:

- Supported first-pass sources are `mock`, `browser`, and `rss`.
- Pipeline stages are fetch, clean, dedupe, score, summarize, rank, and digest.
- Dedupe is stable by URL/title-derived item id.
- Every digest item includes title, score, reasons, optional link, and summary.
- Browser sources navigate, snapshot visible text/elements, and close the session.

### 5. Delivery / Feedback Loop

Acceptance criteria:

- Delivery creates a Markdown digest in `docs/agent/digests`.
- TUI exposes task listing, task creation, run-now, preferences, and feedback commands.
- Feedback writes durable records and participates in future ranking.
- The first delivery channel is local digest/TUI review; real push channels are deferred.

## Manual Acceptance Scenario

```bash
npm run build
npm run task -- create daily-social-brief --every 6h --source mock --query "coding agent"
npm run task -- preferences --interests "AI agent,coding agent,browser automation" --blocked-topics "shallow advice"
npm run task -- run daily-social-brief
npm run task -- list
```

Expected evidence:

- `docs/agent/schedules/tasks.json` contains `daily-social-brief`.
- `docs/agent/events/queue.jsonl` contains the normal event sequence.
- `docs/agent/events/runs.jsonl` contains a passed run.
- `docs/agent/digests/YYYY-MM-DD-daily-social-brief.md` exists and ranks agent/browser items above generic content.

## Browser Scenario

```bash
RUN_BROWSER_LIVE=1 npm run test:live
```

Expected evidence:

- The live browser eval starts a local social-style HTML feed.
- Playwright opens it headlessly through the browser source.
- The generated digest contains the page's agent runtime and feedback-loop content.

## Deferred

- LLM summaries through DeepSeek inside the content pipeline.
- Real social APIs and login/session-aware browser collection.
- Vector memory, embedding recall, and semantic dedupe.
- Push delivery to email, Slack, browser notifications, or mobile.
- Fine-grained per-source rate limits and robots/compliance policy.
