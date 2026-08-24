import assert from "node:assert/strict";
import test from "node:test";
import {
  parseToolArguments,
  ToolArgumentsValidationError,
  validateToolArguments,
} from "../src/tool-arguments.ts";
import type { ToolDefinition } from "../src/types.ts";

type ReadArgs = {
  path: string;
  limit: number;
  options?: {
    include: string[];
  };
};

const readTool: ToolDefinition<ReadArgs> = {
  name: "read",
  description: "Read a file",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "limit"],
    properties: {
      path: { type: "string", minLength: 1 },
      limit: { type: "number", minimum: 1 },
      dryRun: { type: "boolean" },
      options: {
        type: "object",
        additionalProperties: false,
        required: ["include"],
        properties: {
          include: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
};

test("validateToolArguments accepts valid object args", () => {
  const args = { path: "README.md", limit: 20, options: { include: ["title"] } };

  assert.equal(validateToolArguments(readTool, args), args);
});

test("parseToolArguments accepts JSON strings and reuses object validation", () => {
  assert.deepEqual(parseToolArguments(readTool, '{"path":"README.md","limit":20}'), {
    path: "README.md",
    limit: 20,
  });
});

test("rejects common schema failures with stable paths", () => {
  const cases: Array<{ name: string; args: unknown; message: RegExp }> = [
    {
      name: "non-object root",
      args: [],
      message: /\/: expected object, received array/,
    },
    {
      name: "missing required field",
      args: { limit: 20 },
      message: /\/path: missing required property/,
    },
    {
      name: "wrong scalar type",
      args: { path: "README.md", limit: "20" },
      message: /\/limit: expected finite number, received string/,
    },
    {
      name: "empty constrained string",
      args: { path: "", limit: 20 },
      message: /\/path: expected string length >= 1/,
    },
    {
      name: "number below minimum",
      args: { path: "README.md", limit: 0 },
      message: /\/limit: expected number >= 1/,
    },
    {
      name: "unknown property",
      args: { path: "README.md", limit: 20, surprise: true },
      message: /\/surprise: unknown property/,
    },
    {
      name: "nested array path",
      args: { path: "README.md", limit: 20, options: { include: ["ok", ""] } },
      message: /\/options\/include\/1: expected string length >= 1/,
    },
  ];

  for (const invalid of cases) {
    assert.throws(() => {
      validateToolArguments(readTool, invalid.args);
    }, invalid.message, invalid.name);
  }
});

test("rejects invalid JSON strings as tool argument validation errors", () => {
  assert.throws(() => {
    parseToolArguments(readTool, '{"path":');
  }, (error) => {
    return (
      error instanceof ToolArgumentsValidationError &&
      error.toolName === "read" &&
      error.issues.includes("/: invalid JSON")
    );
  });
});

test("errors do not dump unsafe raw input", () => {
  assert.throws(() => {
    validateToolArguments(readTool, { path: "SECRET_VALUE", limit: "twenty" });
  }, (error) => {
    return error instanceof ToolArgumentsValidationError && !error.message.includes("SECRET_VALUE");
  });
});
