import { createHash } from "node:crypto";
import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rate = z.number().int().nonnegative().max(1_000_000_000);
export const priceRateSchema = z.object({
  version: z.string().min(1).max(100), provider: z.string().min(1).max(100), model: z.string().min(1).max(100),
  source: z.url(), checkedAt: z.iso.datetime(), validFrom: z.iso.datetime(), validUntil: z.iso.datetime(),
  inputMicrousdPerMillion: rate, cachedInputMicrousdPerMillion: rate, outputMicrousdPerMillion: rate,
}).strict().refine((value) => Date.parse(value.validUntil) > Date.parse(value.validFrom), "Price validity interval must be positive").readonly();
export const priceCatalogSchema = z.array(priceRateSchema).max(100).refine((entries) => new Set(entries.map((entry) => `${entry.provider}:${entry.model}`)).size === entries.length, "Price catalog has duplicate models");
export type PriceRate = z.infer<typeof priceRateSchema>;
export const frozenPriceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("priced"), rate: priceRateSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine((value) => value.hash === createHash("sha256").update(JSON.stringify(value.rate)).digest("hex"), "Price snapshot hash mismatch"),
  z.object({ kind: z.literal("unknown"), reason: z.enum(["price_missing", "price_not_effective", "price_expired"]) }).strict(),
]);
export type FrozenPrice = z.infer<typeof frozenPriceSchema>;
export const costReadingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("estimated"), nanoUsd: count, usd: z.number().nonnegative(), rateHash: z.string().regex(/^[a-f0-9]{64}$/), rateVersion: z.string(), basis: z.enum(["reported_cache_split", "maximum_input_rate", "preflight_input_estimate"]) }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.string().min(1) }).strict(),
]);
export type CostReading = z.infer<typeof costReadingSchema>;

export const reportedUsageSchema = z.object({
  input: count, output: count, totalTokens: count,
  cacheReadInput: count.optional(), cacheMissInput: count.optional(),
}).strict().superRefine((usage, context) => {
  if (usage.input + usage.output !== usage.totalTokens) context.addIssue({ code: "custom", message: "Inconsistent usage total" });
  if ((usage.cacheReadInput ?? 0) > usage.input || (usage.cacheMissInput ?? 0) > usage.input) context.addIssue({ code: "custom", message: "Invalid cache usage" });
  if (usage.cacheReadInput !== undefined && usage.cacheMissInput !== undefined && usage.cacheReadInput + usage.cacheMissInput !== usage.input) context.addIssue({ code: "custom", message: "Inconsistent cache usage" });
});

export function freezePrice(catalog: unknown, input: { provider: string; model: string; at: string }): FrozenPrice {
  const at = Date.parse(z.iso.datetime().parse(input.at));
  const selected = priceCatalogSchema.parse(catalog).find((entry) => entry.provider === input.provider && entry.model === input.model);
  if (!selected) return { kind: "unknown", reason: "price_missing" };
  if (at < Date.parse(selected.validFrom)) return { kind: "unknown", reason: "price_not_effective" };
  if (at >= Date.parse(selected.validUntil)) return { kind: "unknown", reason: "price_expired" };
  return { kind: "priced", rate: selected, hash: createHash("sha256").update(JSON.stringify(selected)).digest("hex") };
}

function amount(price: Extract<FrozenPrice, { kind: "priced" }>, input: { uncached: number; cached: number; output: number; basis: Extract<CostReading, { kind: "estimated" }>["basis"] }): CostReading {
  const rates = price.rate;
  const numerator = BigInt(input.uncached) * BigInt(rates.inputMicrousdPerMillion)
    + BigInt(input.cached) * BigInt(rates.cachedInputMicrousdPerMillion)
    + BigInt(input.output) * BigInt(rates.outputMicrousdPerMillion);
  const nanos = (numerator + 999n) / 1000n;
  if (nanos > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "unknown", reason: "amount_out_of_range" };
  const nanoUsd = Number(nanos);
  return { kind: "estimated", nanoUsd, usd: nanoUsd / 1_000_000_000, rateHash: price.hash, rateVersion: rates.version, basis: input.basis };
}

export function priceUsage(observed: unknown, price: FrozenPrice): CostReading {
  if (observed === undefined || observed === null) return { kind: "unknown", reason: "usage_missing" };
  const parsed = reportedUsageSchema.safeParse(observed);
  if (!parsed.success) return { kind: "unknown", reason: "usage_invalid" };
  if (price.kind === "unknown") return price;
  const usage = parsed.data;
  const cached = usage.cacheReadInput ?? (usage.cacheMissInput === undefined ? undefined : usage.input - usage.cacheMissInput);
  if (cached === undefined) {
    const useCachedRate = price.rate.cachedInputMicrousdPerMillion > price.rate.inputMicrousdPerMillion;
    return amount(price, { uncached: useCachedRate ? 0 : usage.input, cached: useCachedRate ? usage.input : 0, output: usage.output, basis: "maximum_input_rate" });
  }
  return amount(price, { uncached: usage.input - cached, cached, output: usage.output, basis: "reported_cache_split" });
}

export function estimateCallReservation(price: FrozenPrice, input: { inputTokens: number; maxOutputTokens: number }): CostReading {
  const inputTokens = count.parse(input.inputTokens);
  const output = count.parse(input.maxOutputTokens);
  if (price.kind === "unknown") return price;
  const useCachedRate = price.rate.cachedInputMicrousdPerMillion > price.rate.inputMicrousdPerMillion;
  return amount(price, { uncached: useCachedRate ? 0 : inputTokens, cached: useCachedRate ? inputTokens : 0, output, basis: "preflight_input_estimate" });
}
