import assert from "node:assert/strict";
import test from "node:test";
import { agentPackageReady } from "../src/index.ts";

test("agent package entry is importable", () => {
  assert.equal(agentPackageReady, true);
});
