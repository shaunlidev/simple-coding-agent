# MVP Coding Agent Plan

## Goal

Build the minimal agent described in `../../ARCHITECTURE.md`, with local deterministic tests first and DeepSeek integration last.

## Current Phase

- [x] Phase 0: repository knowledge map and monorepo scaffold
- [x] Phase 1: EventStream
- [ ] Phase 2: provider event validator
- [ ] Phase 3: tool argument validation and Faux Provider
- [ ] Phase 4: Agent loop and Agent class
- [ ] Phase 5: local tools
- [ ] Phase 6: print/json CLI
- [ ] Phase 7: DeepSeek provider and live smoke tests

## Decisions

- Use Node native test runner for early phases to avoid dependency installation.
- Keep DeepSeek out of the default test path.
- Use repository-local docs as the system of record.

## Acceptance Gates

```bash
npm run check
npm run build
npm run test
```
