import type { JsonObject, ToolDefinition, ToolParameterSchema } from "./types.js";

export class ToolArgumentsValidationError extends Error {
  readonly toolName: string;
  readonly issues: readonly string[];

  constructor(toolName: string, issues: readonly string[]) {
    const details = issues.map((issue) => `  - ${issue}`).join("\n");
    super(`Invalid arguments for tool "${toolName}":\n${details}`);
    this.name = "ToolArgumentsValidationError";
    this.toolName = toolName;
    this.issues = [...issues];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function joinPath(path: string, segment: string): string {
  const escaped = segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return path === "/" ? `/${escaped}` : `${path}/${escaped}`;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateAgainstSchema(
  schema: ToolParameterSchema,
  value: unknown,
  path: string,
  issues: string[],
): void {
  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) {
        issues.push(`${path}: expected object, received ${describeType(value)}`);
        return;
      }

      for (const required of schema.required ?? []) {
        if (!(required in value)) {
          issues.push(`${joinPath(path, required)}: missing required property`);
        }
      }

      for (const [key, childValue] of Object.entries(value)) {
        const childSchema = schema.properties[key];
        if (!childSchema) {
          if (schema.additionalProperties === false) {
            issues.push(`${joinPath(path, key)}: unknown property`);
          }
          continue;
        }
        validateAgainstSchema(childSchema, childValue, joinPath(path, key), issues);
      }
      return;
    }

    case "string": {
      if (typeof value !== "string") {
        issues.push(`${path}: expected string, received ${describeType(value)}`);
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push(`${path}: expected string length >= ${schema.minLength}`);
      }
      return;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push(`${path}: expected finite number, received ${describeType(value)}`);
        return;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push(`${path}: expected number >= ${schema.minimum}`);
      }
      return;
    }

    case "boolean": {
      if (typeof value !== "boolean") {
        issues.push(`${path}: expected boolean, received ${describeType(value)}`);
      }
      return;
    }

    case "array": {
      if (!Array.isArray(value)) {
        issues.push(`${path}: expected array, received ${describeType(value)}`);
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push(`${path}: expected array length >= ${schema.minItems}`);
      }
      value.forEach((item, index) => {
        validateAgainstSchema(schema.items, item, joinPath(path, String(index)), issues);
      });
      return;
    }
  }
}

export function validateToolArguments<TArguments extends JsonObject>(
  tool: ToolDefinition<TArguments>,
  args: unknown,
): TArguments {
  const issues: string[] = [];
  validateAgainstSchema(tool.parameters, args, "/", issues);

  if (issues.length > 0) {
    throw new ToolArgumentsValidationError(tool.name, issues);
  }

  return args as TArguments;
}

export function parseToolArguments<TArguments extends JsonObject>(
  tool: ToolDefinition<TArguments>,
  argsJson: string,
): TArguments {
  let parsed: unknown;

  try {
    parsed = JSON.parse(argsJson);
  } catch {
    throw new ToolArgumentsValidationError(tool.name, ["/: invalid JSON"]);
  }

  return validateToolArguments(tool, parsed);
}
