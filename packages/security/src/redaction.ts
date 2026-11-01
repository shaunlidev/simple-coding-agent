import { z } from "zod";

const secretPatterns = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(https?:\/\/)[^\s/]+@/gi,
  /((?:deepseek[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential)["']?[ \t]*[=:][ \t]*["']?)[^\r\n\s"'&,}]+/gi,
  /((?:authorization:\s*)?bearer\s+)[^\s"']+/gi,
];
const sensitiveField = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?secret|password|authorization|cookie|credential|secret|token)$/i;

export function redactSecrets(value: string): string {
  return secretPatterns.reduce((text, pattern) => text.replace(pattern, (_match, prefix: unknown) => `${typeof prefix === "string" ? prefix : ""}[REDACTED]`), value);
}

export function createRedactor(secrets: readonly string[] = []) {
  const configured = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  function text(value: string): string {
    for (const secret of configured) value = value.split(secret).join("[REDACTED]");
    return redactSecrets(value);
  }
  function value(input: unknown, depth = 0): unknown {
    if (depth > 64) return "[TRUNCATED]";
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map((entry) => value(entry, depth + 1));
    if (input instanceof Date) return input.toISOString();
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => [text(key), sensitiveField.test(key) ? "[REDACTED]" : value(entry, depth + 1)]));
    }
    return input;
  }
  function identifier(input: string): string {
    if (text(input) !== input) throw Object.assign(new Error("Secret-like values are not permitted in identifiers"), { statusCode: 400 });
    return input;
  }
  return {
    text, value, identifier,
    record: (input: Record<string, unknown>) => z.record(z.string(), z.unknown()).parse(value(input)),
    json: (input: unknown) => JSON.stringify(value(input)),
  };
}
