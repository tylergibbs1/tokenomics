import { Duration, Effect } from "effect";
import { AppConfig } from "./config.js";
import { FetchError } from "./errors.js";
import { Modality, PRICE_UNIT, type ModelPricing } from "./types.js";

/**
 * Live pricing source: the models.dev catalog (https://models.dev/api.json).
 * One request returns 140+ providers, each serving many models with normalized
 * pricing, so there is no scraping, no LLM extraction, and no database — every
 * query reflects current models.dev data.
 *
 * The same underlying model is often served by several providers at different
 * prices; each (provider, model) pair becomes its own record so prices can be
 * compared across providers.
 */

const SOURCE = "models.dev";
const SOURCE_URL = "https://models.dev";

interface ModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number; input?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  doc?: string;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

/**
 * models.dev prices are already USD per 1M tokens (plain numbers). Validate and
 * round to 6 decimals to remove binary-float noise (e.g. 0.0499999996 → 0.05).
 * A negative or non-finite value is not a real rate, so it maps to null.
 */
function rate(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1e6) / 1e6;
}

/** A positive per-Mtok rate, or null (used for optional cache rates where 0/absent means "no separate rate"). */
function positiveRate(value: number | undefined): number | null {
  const r = rate(value);
  return r != null && r > 0 ? r : null;
}

function deriveModality(m: ModelsDevModel): Modality {
  const family = (m.family ?? "").toLowerCase();
  const name = (m.name ?? "").toLowerCase();
  if (family.includes("rerank") || name.includes("rerank")) return "reranker";
  if (family.includes("embed") || name.includes("embed")) return "embedding";
  const out = m.modalities?.output ?? [];
  const inp = m.modalities?.input ?? [];
  if (out.includes("image")) return "image";
  if (out.includes("audio")) return "audio";
  if (out.includes("video")) return "video";
  if (inp.some((mod) => mod !== "text")) return "multimodal";
  return "text";
}

function mapModel(providerKey: string, modelKey: string, m: ModelsDevModel, fetchedAt: string): ModelPricing | null {
  // Globally unique id: the serving provider plus the model's own id, so the same
  // model served by several providers stays distinguishable (e.g. "openai/gpt-4o",
  // "requesty/xai/grok-4").
  const modelId = `${providerKey}/${modelKey}`;
  const modality = deriveModality(m);
  const input = rate(m.cost?.input);
  // Skip models with no concrete input price (many gateways list models with metadata
  // but no published pricing).
  if (input == null) return null;
  const output = rate(m.cost?.output);

  return {
    provider: providerKey,
    model_id: modelId,
    display_name: m.name ?? modelKey,
    modality,
    pricing: {
      input_per_mtok: input,
      // Embeddings/rerankers are non-generative → output is null, not 0.
      output_per_mtok: modality === "embedding" || modality === "reranker" ? null : output,
      cached_input_per_mtok: positiveRate(m.cost?.cache_read),
      cache_write_per_mtok: positiveRate(m.cost?.cache_write),
    },
    context_window: m.limit?.context ?? null,
    max_output_tokens: m.limit?.output ?? null,
    unit: PRICE_UNIT,
    currency: "USD",
    notes: null,
    source_url: SOURCE_URL,
    fetched_at: fetchedAt,
    source: SOURCE,
  };
}

export class ModelsDev extends Effect.Service<ModelsDev>()("ModelsDev", {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig;

    const fetchFresh = Effect.fn("ModelsDev.fetch")(function* () {
      const url = config.modelsApiUrl;
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            // The models.dev catalog is public — no Authorization header needed.
            headers: { accept: "application/json" },
            signal,
          }),
        catch: (cause) => new FetchError({ url, message: `Network error contacting models.dev: ${String(cause)}` }),
      });

      if (!response.ok) {
        const detail = yield* Effect.promise(() => response.text().catch(() => ""));
        return yield* new FetchError({
          url,
          status: response.status,
          message: `models.dev returned ${response.status} ${response.statusText}: ${detail.slice(0, 200)}`,
        });
      }

      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<ModelsDevResponse>,
        catch: (cause) => new FetchError({ url, message: `models.dev returned invalid JSON: ${String(cause)}` }),
      });

      // Stamp time at the boundary (a side effect kept out of the pure mapper).
      const fetchedAt = new Date().toISOString();
      const out: ModelPricing[] = [];
      for (const [providerKey, provider] of Object.entries(body ?? {})) {
        const models = provider?.models;
        if (!models) continue;
        for (const [modelKey, m] of Object.entries(models)) {
          const mapped = mapModel(providerKey, modelKey, m, fetchedAt);
          if (mapped !== null) out.push(mapped);
        }
      }
      return out;
    });

    // Graceful timeout: a hung network fails fast as a typed FetchError instead of
    // blocking a tool call indefinitely.
    const fetchWithTimeout = fetchFresh().pipe(
      Effect.timeoutFail({
        duration: Duration.millis(config.fetchTimeoutMs),
        onTimeout: () =>
          new FetchError({
            url: config.modelsApiUrl,
            message: `models.dev request timed out after ${config.fetchTimeoutMs}ms.`,
          }),
      }),
    );

    // Reuse a fetched list within the configured window (data stays at most this old).
    // With cacheTtlSeconds = 0, every call fetches fresh.
    const models =
      config.cacheTtlSeconds > 0
        ? yield* Effect.cachedWithTTL(fetchWithTimeout, Duration.seconds(config.cacheTtlSeconds))
        : fetchWithTimeout;

    return { models } as const;
  }),
  dependencies: [],
}) {}
