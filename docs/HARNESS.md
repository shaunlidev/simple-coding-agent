# Harness

## Harness Standard

Every harness should capture enough data for another agent to diagnose failures without hidden chat context.

Capture:

- input prompt or task fixture;
- provider events;
- agent events;
- transcript/messages;
- tool calls and tool results;
- final output;
- errors;
- usage where available;
- temp workspace path while running and cleanup status after running.

## Planned Harnesses

- `createFauxProviderHarness`: deterministic model responses and provider event traces.
- `createAgentHarness`: temp workspace, faux provider, default tools, transcript, event capture.
- CLI process harness: real process boundary, stdout/stderr/exit code.
- Live DeepSeek harness: opt-in model-backed smoke tests.
