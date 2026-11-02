import assert from "node:assert/strict";
import test from "node:test";
import { freezePrice, priceUsage, estimateCallReservation } from "../src/pricing.ts";

const entry = { version: "fixture-v1", provider: "fixture", model: "model", source: "https://example.test/prices", checkedAt: "2026-11-01T00:00:00.000Z", validFrom: "2026-11-01T00:00:00.000Z", validUntil: "2026-12-01T00:00:00.000Z", inputMicrousdPerMillion: 1_000_000, cachedInputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 2_000_000 };
const target = { provider: "fixture", model: "model", at: "2026-11-02T00:00:00.000Z" };
const observed = { input: 100, output: 20, totalTokens: 120, cacheReadInput: 30, cacheMissInput: 70 };

test("R7.1 costs match a hand-calculated fixture and freeze historical rates", () => {
  const catalog = [{ ...entry }];
  const frozen = freezePrice(catalog, target);
  const result = priceUsage(observed, frozen);
  assert.equal(result.kind, "estimated");
  if (result.kind !== "estimated") throw new Error("Expected an estimate");
  assert.equal(result.nanoUsd, 113_000);
  assert.equal(result.usd, 0.000113);
  assert.equal(result.basis, "reported_cache_split");
  catalog[0].inputMicrousdPerMillion *= 2;
  catalog[0].version = "fixture-v2";
  assert.deepEqual(priceUsage(observed, frozen), result);
  assert.notDeepEqual(priceUsage(observed, freezePrice(catalog, target)), result);
  assert.equal(frozen.kind === "priced" && Object.isFrozen(frozen.rate), true);
});

test("R7.1 absent or invalid usage/prices stay unknown", () => {
  const frozen = freezePrice([entry], target);
  for (const value of [undefined, null]) assert.deepEqual(priceUsage(value, frozen), { kind: "unknown", reason: "usage_missing" });
  for (const value of [{ ...observed, cacheReadInput: 101 }, { ...observed, totalTokens: 99 }, { ...observed, cacheMissInput: 69 }]) assert.deepEqual(priceUsage(value, frozen), { kind: "unknown", reason: "usage_invalid" });
  assert.deepEqual(priceUsage(observed, freezePrice([], target)), { kind: "unknown", reason: "price_missing" });
  assert.deepEqual(freezePrice([entry], { ...target, model: "unknown-model" }), { kind: "unknown", reason: "price_missing" });
  assert.deepEqual(freezePrice([entry], { ...target, at: entry.validUntil }), { kind: "unknown", reason: "price_expired" });
  assert.deepEqual(freezePrice([entry], { ...target, at: "2026-10-31T23:59:59.999Z" }), { kind: "unknown", reason: "price_not_effective" });
  assert.throws(() => freezePrice([entry, entry], target), /duplicate/);
});

test("R7.1 missing cache split uses an explicit upper-rate estimate without mutating observations", () => {
  const input = { input: 100, output: 20, totalTokens: 120 };
  const result = priceUsage(input, freezePrice([entry], target));
  assert.equal(result.kind, "estimated");
  if (result.kind !== "estimated") throw new Error("Expected estimate");
  assert.equal(result.nanoUsd, 140_000);
  assert.equal(result.basis, "maximum_input_rate");
  assert.deepEqual(input, { input: 100, output: 20, totalTokens: 120 });
  assert.equal(priceUsage({ ...input, cacheReadInput: 30 }, freezePrice([entry], target)).kind, "estimated");
});

test("R7.4 reservations are labeled input estimates and round upward, never invoice guarantees", () => {
  const frozen = freezePrice([entry], target);
  const result = estimateCallReservation(frozen, { inputTokens: 100, maxOutputTokens: 20 });
  assert.equal(result.kind, "estimated");
  if (result.kind !== "estimated") throw new Error("Expected estimate");
  assert.equal(result.nanoUsd, 140_000);
  assert.equal(result.basis, "preflight_input_estimate");
  const rounded = estimateCallReservation(freezePrice([{ ...entry, inputMicrousdPerMillion: 1, cachedInputMicrousdPerMillion: 0 }], target), { inputTokens: 1, maxOutputTokens: 0 });
  assert.ok(rounded.kind === "estimated" && rounded.nanoUsd === 1);
  assert.throws(() => estimateCallReservation(frozen, { inputTokens: -1, maxOutputTokens: 20 }));
  assert.deepEqual(estimateCallReservation({ kind: "unknown", reason: "price_expired" }, { inputTokens: 100, maxOutputTokens: 20 }), { kind: "unknown", reason: "price_expired" });
});
