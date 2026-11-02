import assert from "node:assert/strict";
import test from "node:test";
import { authenticateLocalIdentity, requireOperator, parseEnvironment } from "../src/index.ts";

test("R6.5 local task identity uses the configured shared users and permissions", () => {
  const secret = "synthetic-operator-secret-at-least-32-characters";
  const viewer = "synthetic-viewer-secret-at-least-32-characters";
  const env = parseEnvironment({ AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret }, { id: "guest", role: "viewer", secret: viewer }]) });
  assert.throws(() => authenticateLocalIdentity(env, {}), /authentication failed/);
  assert.throws(() => authenticateLocalIdentity(env, { id: "owner", secret: "incorrect" }), /authentication failed/);
  assert.throws(() => authenticateLocalIdentity(env, { id: "forged", secret }), /authentication failed/);
  const operator = authenticateLocalIdentity(env, { id: "owner", secret });
  assert.deepEqual(operator, { id: "owner", role: "operator" });
  assert.doesNotThrow(() => requireOperator(operator));
  assert.throws(() => requireOperator(authenticateLocalIdentity(env, { id: "guest", secret: viewer })), /Operator permission/);
});
