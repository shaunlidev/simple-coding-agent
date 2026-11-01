# Simple Coding Agent

Simple Coding Agent is a local-first TypeScript coding-agent MVP. It currently ships a runnable CLI and an interactive streaming terminal UI. Both use the same agent loop, DeepSeek provider, local file tools, browser-tool hooks, and workflow tools.

Status:

- CLI MVP: available locally after build.
- Interactive streaming TUI: available locally after build.
- Browser tools: available when Playwright is installed locally.
- Workflow tools: write requirements, backlog, plans, and verification evidence under `docs/agent/`.
- Scheduled content tasks: local scheduler, event log, memory/preferences, content pipeline, digest delivery, and feedback loop.
- Agent Ops Dashboard: Fastify/React/SQLite control plane with real DeepSeek content runs and cited RSS/web/browser observations. Production acceptance remains in progress.
- npm publishing: not supported yet. This repository is GitHub-only for now.

## Requirements

- Node.js 22.23.4 for the verified build path, as pinned in `.nvmrc` and `.node-version`.
- A DeepSeek API key for real model-backed runs.

## Quickstart

```bash
git clone https://github.com/shaunlidev/simple-coding-agent
cd simple-coding-agent
npm ci
cp -n .env.example .env
```

Edit `.env` and set:

```bash
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-v4-pro
```

Keep an existing `.env`; the command above does not overwrite it. CLI, TUI, task, database, and server npm commands load the project-root `.env`. Already-exported environment variables take precedence. Test commands do not load it.

Then build:

```bash
npm run build
```

Run static checks that do not need a key:

```bash
npm run agent:help
npm run tui:help
npm run task -- --help
npm run dashboard:build
```

Run the CLI with a key in your environment:

```bash
DEEPSEEK_API_KEY=your_key_here npm run agent -- --print "Reply exactly ok"
```

Chat in the terminal UI:

```bash
DEEPSEEK_API_KEY=your_key_here npm run tui
```

Or run a one-shot terminal UI task:

```bash
DEEPSEEK_API_KEY=your_key_here npm run tui -- "Reply exactly ok"
```

## CLI Usage

```bash
npm run agent -- --print "Read package.json and summarize it"
npm run agent -- --json "List the files in this project"
npm run agent -- --cwd /path/to/workspace --print "Inspect README.md"
npm run agent -- --model deepseek-v4-flash --print "Reply exactly ok"
npm run agent -- --thinking --print "Solve this carefully"
npm run agent -- --session .agent-session.jsonl --print "Remember this task"
npm run agent -- --resume .agent-session.jsonl --print "Continue"
```

Without `DEEPSEEK_API_KEY`, run mode fails clearly before provider initialization.

## TUI Usage

```bash
npm run tui
```

Interactive commands:

- `/help`
- `/quit` or `/exit`
- `/clear`
- `/cwd PATH`
- `/model MODEL`
- `/thinking on|off`
- `/session PATH`
- `/spec TITLE | DESCRIPTION | AC1; AC2 | PRIORITY`
- `/backlog`
- `/plan [ID]`
- `/verify ID | passed|failed|blocked | SUMMARY | CMD1; CMD2`
- `/tasks`
- `/task-create ID | EVERY | SOURCE | URL | QUERY`
- `/task-run ID`
- `/feedback TASK ITEM SIGNAL`
- `/preferences INTERESTS | BLOCKED`

The TUI renders each turn as readable `You`, `Agent`, `Tools`, and `status` blocks. Assistant text streams as provider deltas arrive; if a provider does not emit deltas, the TUI falls back to printing the final assistant message once.

## Browser Tools

The agent exposes MCP-inspired browser tools:

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_close`

Install Playwright to use them with a real browser. Browser navigation opens a headed Chromium window by default, unless the model passes `headless: true`.

```bash
npm install -D playwright
npx playwright install chromium
```

Without Playwright, browser tools fail clearly with installation guidance. Local tests use a fake browser adapter and do not require browser downloads.

## Workflow Tools

The agent can maintain local workflow artifacts:

- `docs/agent/inbox.json`
- `docs/agent/backlog.json`
- `docs/agent/specs/*.md`
- `docs/agent/plans/active/*.md`
- `docs/agent/evidence/*.md`

Available tools:

- `workflow_capture_requirement`
- `workflow_list_backlog`
- `workflow_create_plan`
- `workflow_record_verification`

## Scheduled Content Tasks

The task runtime is the first local-first slice of a personalized content agent. It stores all state under `docs/agent`:

- `docs/agent/schedules/tasks.json`
- `docs/agent/events/queue.jsonl`
- `docs/agent/events/runs.jsonl`
- `docs/agent/memory/preferences.json`
- `docs/agent/memory/feedback.jsonl`
- `docs/agent/digests/*.md`

Create and run a mock social brief:

```bash
npm run task -- create daily-social-brief --every 6h --source mock --query "coding agent"
npm run task -- preferences --interests "AI agent,coding agent,browser automation" --blocked-topics "shallow advice"
npm run task -- run daily-social-brief
```

Run due tasks manually or from cron:

```bash
npm run task -- run-due
npm run task -- daemon --interval-ms 60000
```

Record feedback:

```bash
npm run task -- feedback daily-social-brief ITEM_ID saved
npm run task -- feedback daily-social-brief ITEM_ID not_interested
```

Supported first-pass sources are `mock`, `browser`, and `rss`. Browser sources require Playwright and collect visible page text/elements through the same browser adapter used by the agent tools.

## Agent Ops Dashboard

The dashboard is a real Agent Ops control plane for a personalized content agent. It is not a spec or README showcase. The locked production-shaped stack is Fastify, React/Vite, TanStack Query, SQLite, Drizzle ORM, node-cron, SSE, Playwright, and the existing DeepSeek provider.

### Dashboard Access

Dashboard API access now requires a server-side session. Configure identities in the project-root `.env` before signing in. Generate separate random values for the session signing secret and each user's access secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Configuration shape (replace the placeholders with generated values):

```dotenv
AGENT_SESSION_SECRET=<random-session-secret>
AGENT_AUTH_USERS='[{"id":"owner","role":"operator","secret":"<random-operator-secret>"},{"id":"guest","role":"viewer","secret":"<random-viewer-secret>"}]'
AGENT_PUBLIC_ORIGIN=http://127.0.0.1:4175
AGENT_CORS_ORIGIN=http://127.0.0.1:4176
```

Each secret must contain at least 32 characters. Keep these values out of version control. Existing DeepSeek settings are unchanged. An empty user list does not enable anonymous access. Restart the server after changing identities; removing a user or rotating their credential invalidates their sessions.

Operators can run tasks and change state; viewers can read the workspace. Sessions expire after eight hours. Browser requests use an HttpOnly SameSite cookie and a session-bound CSRF token. Production cookies additionally require HTTPS. `AGENT_TRUST_PROXY=1` trusts only a loopback reverse proxy, not arbitrary forwarded headers; the deployment proxy topology still needs R10 validation.

Memory clearing now requires a server-recorded approval. Request `/api/security/approvals` with `{runId, tool: "memory_clear", args: {confirmation: "clear-memory"}}`, approve its ID through `/api/security/approvals/:id/approve`, then execute the bound operation once. These are authenticated operator requests with CSRF. A policy check is informational and never creates an execution approval. Full approval controls in the dashboard are part of R8.

R2 security gates cover authenticated API/SSE/export, bound single-use approvals, validated and pinned outbound HTTP, browser subrequest restrictions, and redaction before new persistence/log writes. See [R2 evidence](docs/evidence/R2-security-boundaries.md) for results and residual risks. This does not scrub historical databases or provide a multi-tenant execution sandbox. R5-R10 and cloud release acceptance remain open; do not expose this branch as a production service.

Run now requires a configured task and a working DeepSeek key. Add source origins to `AGENT_URL_ALLOWLIST`, restart the API, then select **New task**, enter a research request and RSS/web/browser URL, and create the task. Select it and choose **Run now**. Run history exposes tool requests, returned documents, model usage and cited results. A missing key, unavailable source or invalid citation fails explicitly; no automatic demo fallback exists. `AGENT_DEMO_MODE=1` explicitly opts into the old fixture executor for demonstrations and tests only.

The API supports up to four sources and bounded task limits via `PUT /api/tasks/:id` with `{definition, expectedRevision}`; the current minimal form creates single-source tasks. Full editing/navigation is R8. Admission freezes the configuration. Existing schedules without a bound task are paused by migration and must be configured before enabling.

Use **New schedule** to bind a task to cron or an interval such as `@every 6h`, with an explicit IANA timezone and overlap policy. **Run schedule** works while paused and does not move the automatic cursor. Pause blocks new automatic triggers; resume skips the paused window while retaining interval phase. Run history provides **Cancel run**. Cancellation remains `cancelling` until provider/tool/browser cleanup has settled; cancelled work cannot deliver results.

The single workspace worker processes a durable SQLite FIFO. `skip` consumes a trigger without executing, `queue` retains each accepted run, and `cancel_previous` cancels older work for the same task before its replacement executes. Restart preserves queued snapshots and marks interrupted executions failed instead of silently repeating paid requests. Missed automatic occurrences coalesce into at most one catch-up per schedule. The API owns runtime timestamps; clients cannot set `nextRunAt`, `lastRunAt` or override the worker clock.

Run only one worker against a database on local persistent storage. A sibling `<database>.worker-lock` SQLite file holds a process-lifetime exclusive transaction; do not delete, replace or copy over that lock while the worker runs. Another live worker refuses startup. Stop the old process before upgrades, and use SIGTERM/SIGINT for abort-and-drain shutdown. Network filesystems, multi-host workers and exactly-once external requests are not supported.

Runtime history keeps each run's result and returns `no_new_items` when there is nothing new to deliver. Manual-run API clients send `{taskId}` and retain one `Idempotency-Key` per intended action across transport retries; reusing it for another target returns 409. A new intentional run uses a new key. The UI retains the key after a request error.

Network resolution defaults to the system DNS. Some local VPNs return fake addresses in `198.18.0.0/15`; those remain denied. For that environment, explicitly set `AGENT_DNS_MODE=cloudflare` to use Cloudflare's fixed HTTPS resolver. DNS queries then go to Cloudflare; source origin allowlists, rejection of all private/reserved answers, redirects and pinned connections remain enforced. This is not a setting to permit internal URLs. Do not change host DNS or allow private ranges to pass a test.

Database migrations are versioned and transactional. Back up an existing SQLite database before upgrading. Surviving legacy rows are imported, but old outputs already discarded by the previous schema cannot be reconstructed; those receipts are marked `legacy_incomplete`. Reads and readiness checks no longer create demo runs. `db:seed` explicitly creates demo data; skip that command for an empty workspace.

Initialize the local database:

```bash
npm run db:migrate
```

`npm run db:seed` is optional and creates labeled demo history; it is not needed for real tasks.

Run the API:

```bash
npm run build
npm run server
```

In another shell, run the dashboard:

```bash
npm run dashboard
```

Build a hostable static version:

```bash
npm run dashboard:build
```

Default local endpoints:

- API: `http://127.0.0.1:4175`
- Dashboard dev server: `http://127.0.0.1:4176`
- Health: `http://127.0.0.1:4175/healthz`
- Readiness: `http://127.0.0.1:4175/readyz`

After `npm run dashboard:build`, the API also serves the built dashboard at `http://127.0.0.1:4175`. Production UI, API, and SSE share that origin.

The implementation follows `docs/plans/active/0008-agent-ops-dashboard-production.md` and the approved repairs in `0009-agent-ops-acceptance-recovery.md`. Production acceptance is open. Each repair batch requires plan, acceptance criteria, implementation, and verification before the next batch starts.

## Docker

Build and run the API with the built dashboard:

```bash
docker compose up --build
```

Then open:

- Dashboard: `http://localhost:4175`
- API: `http://localhost:4175`

Docker health checks call the Fastify `/healthz` endpoint. Runtime state is stored in the `agent-data` Docker volume. The compose port binds to localhost during acceptance repair. Set the DeepSeek key in `.env` before starting the production container.

## Local Safety

- The model can only use tools rooted at `--cwd`, or the current working directory if `--cwd` is omitted.
- File reads, writes, and edits reject path escapes and symlink escapes.
- `bash` runs with a scrubbed environment. API keys, tokens, secrets, passwords, and common cloud credentials are not passed to subprocesses by default.
- Session JSONL records refuse to serialize the active `DEEPSEEK_API_KEY`.
- `.env` files are ignored by git. `.env.example` is safe to commit.
- Agent Ops API responses, SSE snapshots, audit records, and error envelopes redact secret-like values.
- Browser navigation and URL collection use `AGENT_URL_ALLOWLIST`.
- High-risk/write tools require approval before execution and denied attempts are written to the SQLite audit trail.

Production secret enforcement:

```bash
AGENT_REQUIRE_PRODUCTION_SECRETS=1 npm run server
```

With enforcement enabled, startup fails clearly if `DEEPSEEK_API_KEY` is missing.

## Testing

Local gates do not require network or a real key:

```bash
npm run check
npm run build
npm run check:package-boundaries
npm run dashboard:build
npm run test
npm run eval
```

Agent Ops evals and harnesses are tracked in the phase plan. The old `docs/demo` portfolio artifact flow is no longer part of the product direction.

Live DeepSeek smoke tests are opt-in:

```bash
DEEPSEEK_API_KEY=your_key_here npm run test:live
```

Without `DEEPSEEK_API_KEY`, the live gate skips model calls quickly.

The browser collection scenario is also opt-in:

```bash
RUN_BROWSER_LIVE=1 npm run test:live
```

## Troubleshooting

- `DEEPSEEK_API_KEY is required`: export the key in the same shell command or source your `.env` with your preferred shell tooling.
- `Cannot find module .../dist/...`: run `npm run build`.
- Unsupported Node behavior: use the pinned Node.js 22.23.4. Parser dependencies require Node 22.22.2+, 24.15.0+, or 26+ within those supported major ranges.

## Publishing

This project is not published to npm yet. Use the GitHub clone workflow above.
