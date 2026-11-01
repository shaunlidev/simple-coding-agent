import { z } from "zod";

export const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-v4-pro"),
  AGENT_DB_PATH: z.string().min(1).default("data/agent-ops.sqlite"),
  AGENT_SERVER_HOST: z.string().min(1).default("127.0.0.1"),
  AGENT_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4175),
  AGENT_DASHBOARD_API_BASE_URL: z.string().url().default("http://127.0.0.1:4175"),
  AGENT_CORS_ORIGIN: z.string().min(1).default("http://127.0.0.1:4176"),
  AGENT_URL_ALLOWLIST: z.string().min(1).default("https://example.com,https://example.test,https://www.bilibili.com"),
  AGENT_REQUIRE_PRODUCTION_SECRETS: z.enum(["0", "1", "false", "true"]).default("0"),
  NODE_ENV: z.string().optional(),
}).superRefine((env, context) => {
  const requiresSecrets = env.AGENT_REQUIRE_PRODUCTION_SECRETS === "1" || env.AGENT_REQUIRE_PRODUCTION_SECRETS === "true" || env.NODE_ENV === "production";
  if (requiresSecrets && !env.DEEPSEEK_API_KEY) {
    context.addIssue({
      code: "custom",
      path: ["DEEPSEEK_API_KEY"],
      message: "DEEPSEEK_API_KEY is required when production secret enforcement is enabled",
    });
  }
});

export type AgentEnvironment = z.infer<typeof envSchema>;

const secretPatterns = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(deepseek[_-]?api[_-]?key[ \t]*[=:][ \t]*)[^\r\n\s"']+/gi,
  /(api[_-]?key[ \t]*[=:][ \t]*)[^\r\n\s"']+/gi,
  /(token[ \t]*[=:][ \t]*)[^\r\n\s"']+/gi,
  /(password[ \t]*[=:][ \t]*)[^\r\n\s"']+/gi,
  /(authorization:\s*bearer\s+)[^\s"']+/gi,
  /(bearer\s+)[A-Za-z0-9._-]{12,}/gi,
];

export function parseEnvironment(env: Record<string, string | undefined>): AgentEnvironment {
  return envSchema.parse(env);
}

export function redactSecrets(value: string): string {
  return secretPatterns.reduce((text, pattern) => text.replace(pattern, (match, prefix: string | undefined) => `${prefix ?? ""}[REDACTED]`), value);
}

export type ToolRisk = "low" | "medium" | "high";

export type ToolPolicy = {
  name: string;
  risk: ToolRisk;
  requiresApproval: boolean;
  readOnly: boolean;
  urlAllowlistRequired?: boolean;
};

export type ToolDecision = {
  allowed: boolean;
  tool: string;
  risk: ToolRisk;
  readOnly: boolean;
  reason: string;
};

export type SecretFinding = {
  label: string;
  index: number;
  preview: string;
};

export function defaultToolPolicies(): ToolPolicy[] {
  return [
    { name: "browser_snapshot", risk: "low", requiresApproval: false, readOnly: true },
    { name: "browser_navigate", risk: "medium", requiresApproval: false, readOnly: true, urlAllowlistRequired: true },
    { name: "content_fetch_url", risk: "medium", requiresApproval: false, readOnly: true, urlAllowlistRequired: true },
    { name: "browser_type", risk: "high", requiresApproval: true, readOnly: false },
    { name: "browser_click", risk: "high", requiresApproval: true, readOnly: false },
    { name: "social_post_publish", risk: "high", requiresApproval: true, readOnly: false },
  ];
}

export function parseUrlAllowlist(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function isUrlAllowed(url: string, allowlist: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return allowlist.some((allowed) => {
    try {
      const parsedAllowed = new URL(allowed);
      return parsed.protocol === parsedAllowed.protocol && parsed.hostname === parsedAllowed.hostname;
    } catch {
      return parsed.hostname === allowed;
    }
  });
}

export function evaluateToolCall(input: {
  toolName: string;
  approved?: boolean;
  url?: string;
  allowlist?: string[];
  policies?: ToolPolicy[];
}): ToolDecision {
  const policies = input.policies ?? defaultToolPolicies();
  const policy = policies.find((candidate) => candidate.name === input.toolName) ?? {
    name: input.toolName,
    risk: "high" as ToolRisk,
    requiresApproval: true,
    readOnly: false,
  };
  if (policy.urlAllowlistRequired) {
    if (!input.url) {
      return { allowed: false, tool: policy.name, risk: policy.risk, readOnly: policy.readOnly, reason: "URL is required for allowlist validation" };
    }
    if (!isUrlAllowed(input.url, input.allowlist ?? [])) {
      return { allowed: false, tool: policy.name, risk: policy.risk, readOnly: policy.readOnly, reason: `URL is outside allowlist: ${input.url}` };
    }
  }
  if (policy.requiresApproval && !input.approved) {
    return { allowed: false, tool: policy.name, risk: policy.risk, readOnly: policy.readOnly, reason: `Tool requires approval: ${policy.name}` };
  }
  return { allowed: true, tool: policy.name, risk: policy.risk, readOnly: policy.readOnly, reason: "Allowed by tool policy" };
}

export function scanForSecrets(value: string): { passed: boolean; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  const labelledPatterns: Array<{ label: string; pattern: RegExp }> = [
    { label: "openai/deepseek style key", pattern: /sk-[A-Za-z0-9_-]{12,}/g },
    { label: "api key assignment", pattern: /(deepseek[_-]?api[_-]?key|api[_-]?key)[ \t]*[=:][ \t]*[^\r\n\s"']+/gi },
    { label: "token assignment", pattern: /token[ \t]*[=:][ \t]*[^\r\n\s"']+/gi },
    { label: "password assignment", pattern: /password[ \t]*[=:][ \t]*[^\r\n\s"']+/gi },
    { label: "bearer token", pattern: /bearer\s+[A-Za-z0-9._-]{12,}/gi },
  ];
  const placeholderPattern = /(your[_-]?key[_-]?here|example|changeme|replace[_-]?me|\[REDACTED\])$/i;
  for (const { label, pattern } of labelledPatterns) {
    for (const match of value.matchAll(pattern)) {
      const raw = match[0].split(/[=:]\s*|\s+/).at(-1) ?? "";
      if (placeholderPattern.test(raw)) continue;
      findings.push({
        label,
        index: match.index ?? 0,
        preview: redactSecrets(match[0]),
      });
    }
  }
  return { passed: findings.length === 0, findings };
}
