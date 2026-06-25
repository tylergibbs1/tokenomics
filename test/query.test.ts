import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCost, findModel, searchModels } from "../src/core/query.js";
import type { ModelPricing } from "../src/core/types.js";

const model = (over: Partial<ModelPricing> & Pick<ModelPricing, "provider" | "model_id">): ModelPricing => ({
  provider: over.provider,
  model_id: over.model_id,
  display_name: over.display_name ?? over.model_id,
  modality: over.modality ?? "text",
  pricing: over.pricing ?? { input_per_mtok: 1, output_per_mtok: 2 },
  context_window: over.context_window ?? 128000,
  max_output_tokens: over.max_output_tokens ?? null,
  unit: "USD per 1M tokens",
  currency: "USD",
  notes: null,
  source_url: `https://openrouter.ai/models/${over.model_id}`,
  fetched_at: "2026-06-25T00:00:00.000Z",
  source: "openrouter",
});

const catalog: ModelPricing[] = [
  model({ provider: "openai", model_id: "openai/gpt-4o", pricing: { input_per_mtok: 2.5, output_per_mtok: 10 } }),
  model({
    provider: "google",
    model_id: "google/gemini-2.5-flash",
    pricing: { input_per_mtok: 0.3, output_per_mtok: 2.5 },
  }),
  model({
    provider: "openai",
    model_id: "openai/text-embedding-3-small",
    modality: "embedding",
    pricing: { input_per_mtok: 0.02, output_per_mtok: null },
  }),
];

test("estimateCost computes per-million math and totals", () => {
  const e = estimateCost(catalog[0], { inputTokens: 1_000_000, outputTokens: 200_000, requests: 10 });
  assert.equal(e.breakdown.input_usd, 2.5);
  assert.equal(e.breakdown.output_usd, 2);
  assert.equal(e.per_request_usd, 4.5);
  assert.equal(e.total_usd, 45);
});

test("estimateCost warns and bills $0 output for non-generative models", () => {
  const e = estimateCost(catalog[2], { inputTokens: 500_000, outputTokens: 1000 });
  assert.equal(e.breakdown.output_usd, 0);
  assert.ok(e.warnings.some((w) => w.includes("no output price")));
});

test("estimateCost falls back to standard input rate when no cached rate, with a warning", () => {
  const e = estimateCost(catalog[0], { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(e.breakdown.cached_input_usd, 2.5);
  assert.ok(e.warnings.some((w) => w.toLowerCase().includes("cached")));
});

test("searchModels filters by price and sorts cheapest input first", () => {
  const r = searchModels(catalog, { maxInputPerMtok: 1, limit: 10, offset: 0 });
  assert.deepEqual(
    r.models.map((m) => m.model_id),
    ["openai/text-embedding-3-small", "google/gemini-2.5-flash"],
  );
  assert.equal(r.total, 2);
});

test("searchModels paginates and reports truncation", () => {
  const r = searchModels(catalog, { limit: 1, offset: 0 });
  assert.equal(r.models.length, 1);
  assert.equal(r.truncated, true);
  assert.match(r.note ?? "", /Showing 1 of 3/);
});

test("findModel resolves exact id ignoring separators/case", () => {
  const m = findModel(catalog, "OpenAI GPT 4o");
  assert.equal(m.match?.model_id, "openai/gpt-4o");
});

test("findModel returns candidates when ambiguous", () => {
  const m = findModel(catalog, "openai");
  assert.equal(m.match, undefined);
  assert.deepEqual(m.candidates.sort(), ["openai/gpt-4o", "openai/text-embedding-3-small"]);
});
