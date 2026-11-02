import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const practiceRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("minimum_quotes"), count: z.number().int().min(1).max(3) }).strict(),
  z.object({ kind: z.literal("source_delivery_cap"), maximum: z.number().int().min(1).max(10) }).strict(),
  z.object({ kind: z.literal("source_rank_bias"), sourceId: z.string().min(1).max(64), delta: z.number().int().min(-10).max(10).refine((value) => value !== 0) }).strict(),
]);
export const practiceRulesSchema = z.array(practiceRuleSchema).min(1).max(8).refine((rules) => new Set(rules.map((rule) => rule.kind === "source_rank_bias" ? `${rule.kind}:${rule.sourceId}` : rule.kind)).size === rules.length, "Duplicate practice rule");
export type PracticeRule = z.infer<typeof practiceRuleSchema>;
export const practiceSnapshotSchema = z.object({ id: z.string(), hash: z.string(), rules: practiceRulesSchema, compilerHash: z.string() });
export type PracticeSnapshot = z.infer<typeof practiceSnapshotSchema>;

export function practiceInstructions(rules: readonly PracticeRule[]): string {
  return rules.filter((rule) => rule.kind === "minimum_quotes").map((rule) => `Include at least ${rule.count} distinct exact supporting quotes per result. Never fabricate a quote to satisfy this requirement.`).join("\n");
}

export function practiceRank(score: number, sourceId: string, rules: readonly PracticeRule[]) {
  const bias = rules.find((rule) => rule.kind === "source_rank_bias" && rule.sourceId === sourceId);
  const delta = bias?.kind === "source_rank_bias" ? bias.delta : 0;
  return { score: Math.max(0, Math.min(100, score + delta)), delta };
}

export function validatePracticeQuotes(items: ReadonlyArray<{ citations: ReadonlyArray<{ quote: string }> }>, rules: readonly PracticeRule[]): void {
  const minimum = rules.find((rule) => rule.kind === "minimum_quotes");
  if (minimum?.kind === "minimum_quotes" && items.some((item) => new Set(item.citations.map((citation) => citation.quote)).size < minimum.count)) throw new Error(`Active practice requires ${minimum.count} distinct supporting quotes`);
}

export function practiceSelection(items: ReadonlyArray<{ source: string }>, rules: readonly PracticeRule[]): boolean[] {
  const cap = rules.find((rule) => rule.kind === "source_delivery_cap");
  const counts = new Map<string, number>();
  return items.map((item) => {
    const count = (counts.get(item.source) ?? 0) + 1;
    counts.set(item.source, count);
    return cap?.kind !== "source_delivery_cap" || count <= cap.maximum;
  });
}

export type PracticeEvalCheck = { name: string; passed: boolean; expected: string; actual: string };
export function evaluatePracticeRules(rules: readonly PracticeRule[]): PracticeEvalCheck[] {
  const checks: PracticeEvalCheck[] = [];
  for (const rule of rules) {
    if (rule.kind === "source_rank_bias") {
      const actual = [practiceRank(50, rule.sourceId, rules).score, practiceRank(50, "__unrelated_source__", rules).score, practiceRank(100, rule.sourceId, rules).score, practiceRank(0, rule.sourceId, rules).score];
      const expected = [50 + rule.delta, 50, Math.min(100, 100 + rule.delta), Math.max(0, rule.delta)];
      checks.push({ name: `bias:${rule.sourceId}`, passed: JSON.stringify(actual) === JSON.stringify(expected), expected: JSON.stringify(expected), actual: JSON.stringify(actual) });
    } else if (rule.kind === "minimum_quotes") {
      const accepted = Array.from({ length: rule.count }, (_, index) => ({ quote: `Independent supporting sentence ${index}` }));
      let rejected = false;
      try { validatePracticeQuotes([{ citations: accepted.slice(1) }], rules); } catch { rejected = true; }
      let valid = true;
      try { validatePracticeQuotes([{ citations: accepted }], rules); } catch { valid = false; }
      checks.push({ name: "minimum-quotes", passed: rejected && valid, expected: "reject insufficient, accept sufficient", actual: `rejected=${rejected}, valid=${valid}` });
    } else {
      const items = [...Array.from({ length: rule.maximum + 1 }, () => ({ source: "first" })), { source: "second" }];
      const selected = practiceSelection(items, rules);
      checks.push({ name: "source-cap", passed: selected.filter(Boolean).length === rule.maximum + 1 && !selected[rule.maximum] && selected.at(-1) === true, expected: `${rule.maximum} first-source, 1 second-source`, actual: JSON.stringify(selected) });
    }
  }
  const baseline = practiceRank(50, "neutral", []);
  checks.push({ name: "empty-baseline", passed: baseline.score === 50 && baseline.delta === 0, expected: "50/0", actual: `${baseline.score}/${baseline.delta}` });
  return checks;
}

export function practiceCompilerHash(): string {
  return implementationHash;
}

// Bind eligibility to the whole executing runtime, including evaluator and commit enforcement.
const modulePath = fileURLToPath(import.meta.url);
const implementationFiles = readdirSync(dirname(modulePath)).filter((name) => name.endsWith(extname(modulePath)) && !name.endsWith(".d.ts")).sort();
const implementationHash = createHash("sha256").update(JSON.stringify(implementationFiles.map((name) => ({ name, hash: createHash("sha256").update(readFileSync(join(dirname(modulePath), name))).digest("hex") })))).digest("hex");
