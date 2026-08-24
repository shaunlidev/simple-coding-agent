# MVP Coding Agent Plan

## Goal

Build the minimal agent described in `../../ARCHITECTURE.md`, with local deterministic tests first and DeepSeek integration last.

## Current Phase

- [x] Phase 0: repository knowledge map and monorepo scaffold
- [x] Phase 1: EventStream
- [x] Phase 2: provider event validator
- [x] Phase 3: tool argument validation and Faux Provider
- [x] Phase 4: Agent loop and Agent class
- [x] Phase 5: local tools
- [x] Phase 6: print/json CLI
- [x] Phase 7: DeepSeek provider and live smoke tests

## Decisions

- Use Node native test runner for early phases to avoid dependency installation.
- Keep DeepSeek out of the default test path.
- Use repository-local docs as the system of record.
- Provider stream events are validated as an ordered sequence before they are yielded to consumers.
- Tool-call argument deltas are accumulated as JSON text and parsed only at `tool_call_end`.
- Tool argument validation uses a small local JSON-schema subset for now; the tests are the contract if this later moves to TypeBox/AJV.
- Source `.js` shims in `packages/ai/src` exist only so Node's experimental TypeScript test runner can resolve build-style imports during local tests.
- Agent loop uses Faux Provider for deterministic local tests and treats unknown tools as runtime failures.
- Local tools enforce workspace root boundaries before read/write/edit/bash behavior is exposed to the agent.
- CLI static commands never initialize runtime; default local CLI runtime uses deterministic echo behavior for smoke tests.
- DeepSeek uses the official OpenAI-compatible `/chat/completions` endpoint with thinking disabled for MVP; live tests are opt-in through `DEEPSEEK_API_KEY`.

## Acceptance Gates

```bash
npm run check
npm run build
npm run test
```
