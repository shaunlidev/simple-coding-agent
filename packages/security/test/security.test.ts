import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolCall, isUrlAllowed, parseEnvironment, parseUrlAllowlist, redactSecrets, scanForSecrets } from "../src/index.ts";

test("security parses defaults and redacts secret-like values", () => {
  const env = parseEnvironment({});

  assert.equal(env.DEEPSEEK_MODEL, "deepseek-v4-pro");
  assert.equal(env.AGENT_SERVER_PORT, 4175);
  assert.equal(redactSecrets("api_key = sk-aaaaaaaaaaaaaaaa"), "api_key = [REDACTED]");
  assert.equal(redactSecrets("authorization: Bearer secret-token-value"), "authorization: Bearer [REDACTED]");
});

test("security requires production API key when enforcement is enabled", () => {
  assert.throws(
    () => parseEnvironment({ AGENT_REQUIRE_PRODUCTION_SECRETS: "1" }),
    /DEEPSEEK_API_KEY is required/,
  );
});

test("security scans secrets without exposing raw findings", () => {
  const result = scanForSecrets("DEEPSEEK_API_KEY=sk-aaaaaaaaaaaaaaaa token=super-secret-value");

  assert.equal(result.passed, false);
  assert.equal(result.findings.length >= 2, true);
  assert.equal(JSON.stringify(result).includes("sk-aaaaaaaaaaaaaaaa"), false);
  assert.equal(JSON.stringify(result).includes("super-secret-value"), false);
});

test("security enforces URL allowlist and high-risk tool approval", () => {
  const allowlist = parseUrlAllowlist("https://example.test,https://www.bilibili.com");
  const allowedRead = evaluateToolCall({ toolName: "browser_navigate", url: "https://www.bilibili.com/video", allowlist });
  const deniedUrl = evaluateToolCall({ toolName: "browser_navigate", url: "https://evil.test", allowlist });
  const deniedWrite = evaluateToolCall({ toolName: "browser_type", allowlist });
  const approvedWrite = evaluateToolCall({ toolName: "browser_type", approved: true, allowlist });

  assert.equal(isUrlAllowed("https://example.test/post/1", allowlist), true);
  assert.equal(allowedRead.allowed, true);
  assert.equal(deniedUrl.allowed, false);
  assert.match(deniedUrl.reason, /outside allowlist/);
  assert.equal(deniedWrite.allowed, false);
  assert.equal(approvedWrite.allowed, true);
});
