import assert from "node:assert/strict";
import test from "node:test";
import { codingAgentPackageReady } from "../src/index.ts";

test("coding-agent package entry is importable", () => {
  assert.equal(codingAgentPackageReady, true);
});
