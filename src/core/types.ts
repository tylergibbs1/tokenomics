import { z } from "zod";

/**
 * All monetary values are USD. All token prices are expressed PER 1,000,000 TOKENS
 * (the industry-standard "per million tokens" unit), so a value of `1.25` means
 * $1.25 per 1M tokens. Storing a single, explicit unit avoids the most common
 * agent error: mixing per-1K and per-1M prices.
 */
export const PRICE_UNIT = "USD per 1M tokens" as const;

export const Modality = z.enum(["text", "multimodal", "embedding", "image", "audio", "video", "reranker", "other"]);
export type Modality = z.infer<typeof Modality>;

/** Token-based pricing. Fields are optional because not every model exposes every rate. */
export const TokenPricing = z.object({
  input_per_mtok: z.number().nonnegative().describe("USD per 1M input (prompt) tokens"),
  output_per_mtok: z
    .number()
    .nonnegative()
    .nullable()
    .describe("USD per 1M output (completion) tokens. null for embedding/non-generative models."),
  cached_input_per_mtok: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe("USD per 1M cached/prompt-cache-hit input tokens, if the provider offers prompt caching."),
  cache_write_per_mtok: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe("USD per 1M tokens to write to prompt cache, if billed separately (e.g. Anthropic)."),
});
export type TokenPricing = z.infer<typeof TokenPricing>;

/** One model's pricing, with full provenance so agents can judge trust + freshness. */
export const ModelPricing = z.object({
  provider: z.string().describe("Provider id, lowercase, e.g. 'openai', 'anthropic', 'google'."),
  model_id: z.string().describe("Canonical model id, e.g. 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet'."),
  display_name: z.string().describe("Human-readable model name, e.g. 'GPT-4o'."),
  modality: Modality,
  pricing: TokenPricing,
  context_window: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Max context window in tokens, if documented."),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  unit: z.literal(PRICE_UNIT).default(PRICE_UNIT),
  currency: z.literal("USD").default("USD"),
  notes: z
    .string()
    .nullable()
    .optional()
    .describe("Short caveats from the pricing page, e.g. 'batch API 50% off', 'first 1M tokens/day free'."),
  source_url: z.string().url().describe("Canonical page for this model on the data source."),
  fetched_at: z.string().datetime().describe("ISO 8601 timestamp when this record was fetched from the source."),
  source: z.string().describe("Data source the record came from, e.g. 'models.dev'."),
});
export type ModelPricing = z.infer<typeof ModelPricing>;
