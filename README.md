# Simple Coding Agent

Simple Coding Agent is a local-first TypeScript coding-agent MVP. It currently ships a runnable CLI and a minimal terminal task UI. Both use the same agent loop, DeepSeek provider, and local file tools.

Status:

- CLI MVP: available locally after build.
- Minimal TUI: available locally after build.
- npm publishing: not supported yet. This repository is GitHub-only for now.

## Requirements

- Node.js 22.19 or newer.
- A DeepSeek API key for real model-backed runs.

## Quickstart

```bash
git clone https://github.com/shaunlidev/simple-coding-agent
cd simple-coding-agent
npm install
cp .env.example .env
```

Edit `.env` and set:

```bash
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-v4-pro
```

Then build:

```bash
npm run build
```

Run static checks that do not need a key:

```bash
npm run agent:help
npm run tui:help
```

Run the CLI with a key in your environment:

```bash
DEEPSEEK_API_KEY=your_key_here npm run agent -- --print "Reply exactly ok"
```

Run the terminal UI:

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

## Local Safety

- The model can only use tools rooted at `--cwd`, or the current working directory if `--cwd` is omitted.
- File reads, writes, and edits reject path escapes and symlink escapes.
- `bash` runs with a scrubbed environment. API keys, tokens, secrets, passwords, and common cloud credentials are not passed to subprocesses by default.
- Session JSONL records refuse to serialize the active `DEEPSEEK_API_KEY`.
- `.env` files are ignored by git. `.env.example` is safe to commit.

## Testing

Local gates do not require network or a real key:

```bash
npm run check
npm run build
npm run check:package-boundaries
npm run test
npm run eval
```

Live DeepSeek smoke tests are opt-in:

```bash
DEEPSEEK_API_KEY=your_key_here npm run test:live
```

Without `DEEPSEEK_API_KEY`, the live gate skips model calls quickly.

## Troubleshooting

- `DEEPSEEK_API_KEY is required`: export the key in the same shell command or source your `.env` with your preferred shell tooling.
- `Cannot find module .../dist/...`: run `npm run build`.
- Unsupported Node behavior: check `node --version`; this repo expects Node.js 22.19+.

## Publishing

This project is not published to npm yet. Use the GitHub clone workflow above.
