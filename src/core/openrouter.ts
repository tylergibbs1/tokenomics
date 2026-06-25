import { Duration, Effect } from "effect";
import { AppConfig } from "./config.js";
import { FetchError } from "./errors.js";
import { Modality, PRICE_UNIT, type ModelPricing } from "./types.js";

/**
 * Live pricing source: the OpenRouter Models API (https://openrouter.ai/docs).
 * One request returns 400+ models with normalized pricing, so there is no scraping,
 * no LLM extraction, and no database — every query reflects current OpenRouter data.
 */

const SOURCE = "openrouter";

interface OpenRouterModel {
  id?: string;
  canonical_slug?: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, string | undefined>;
  top_provider?: { context_length?: number; max_completion_tokens?: number | null };
}

/**
 * OpenRouter prices are USD per token (as strings). Convert to USD per 1M tokens.
 * OpenRouter uses "-1" to mark dynamic/variable pricing (e.g. auto-router meta-models);
 * such values are not real rates, so they map to null.
 */
function perMtok(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Round to 6 decimals to remove binary-float noise (e.g. 0.0499999996 → 0.05).
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

/** A positive per-Mtok rate, or null (used for optional cache rates where 0 means "no separate rate"). */
function positiveRate(value: string | undefined): number | null {
  const r = perMtok(value);
  return r != null && r > 0 ? r : null;
}

function deriveModality(arch: OpenRouterModel["architecture"]): Modality {
  const out = arch?.output_modalities ?? [];
  const inp = arch?.input_modalities ?? [];
  if (out.includes("image")) return "image";
  if (out.includes("audio")) return "audio";
  if (out.includes("embeddings")) return "embedding";
  if (inp.some((m) => m !== "text")) return "multimodal";
  return "text";
}

function mapModel(m: OpenRouterModel, fetchedAt: string): ModelPricing | null {
  const id = m.id ?? m.canonical_slug;
  if (!id) return null;
  const provider = id.includes("/") ? id.split("/")[0] : id;
  const modality = deriveModality(m.architecture);
  const input = perMtok(m.pricing?.prompt);
  // Skip models with no concrete input price (e.g. dynamic-priced router meta-models).
  if (input == null) return null;
  const completion = perMtok(m.pricing?.completion);

  return {
    provider,
    model_id: id,
    display_name: m.name ?? id,
    modality,
    pricing: {
      input_per_mtok: input,
      // Embeddings/rerankers are non-generative → output is null, not 0.
      output_per_mtok: modality === "embedding" || modality === "reranker" ? null : completion,
      cached_input_per_mtok: positiveRate(m.pricing?.input_cache_read),
      cache_write_per_mtok: positiveRate(m.pricing?.input_cache_write),
    },
    context_window: m.top_provider?.context_length ?? m.context_length ?? null,
    max_output_tokens: m.top_provider?.max_completion_tokens ?? null,
    unit: PRICE_UNIT,
    currency: "USD",
    notes: null,
    source_url: `https://openrouter.ai/models/${id}`,
    fetched_at: fetchedAt,
    source: SOURCE,
  };
}

export class OpenRouter extends Effect.Service<OpenRouter>()("OpenRouter", {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig;

    const fetchFresh = Effect.fn("OpenRouter.fetch")(function* () {
      const url = config.openRouterApiUrl;
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            // The OpenRouter /models endpoint is public — no Authorization header needed.
            headers: { accept: "application/json" },
            signal,
          }),
        catch: (cause) => new FetchError({ url, message: `Network error contacting OpenRouter: ${String(cause)}` }),
      });

      if (!response.ok) {
        const detail = yield* Effect.promise(() => response.text().catch(() => ""));
        return yield* new FetchError({
          url,
          status: response.status,
          message: `OpenRouter returned ${response.status} ${response.statusText}: ${detail.slice(0, 200)}`,
        });
      }

      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ data?: OpenRouterModel[] }>,
        catch: (cause) => new FetchError({ url, message: `OpenRouter returned invalid JSON: ${String(cause)}` }),
      });

      const data = body.data ?? [];
      // Stamp time at the boundary (a side effect kept out of the pure mapper).
      const fetchedAt = new Date().toISOString();
      return data.map((m) => mapModel(m, fetchedAt)).filter((m): m is ModelPricing => m !== null);
    });

    // Graceful timeout: a hung network fails fast as a typed FetchError instead of
    // blocking a tool call indefinitely.
    const fetchWithTimeout = fetchFresh().pipe(
      Effect.timeoutFail({
        duration: Duration.millis(config.fetchTimeoutMs),
        onTimeout: () =>
          new FetchError({
            url: config.openRouterApiUrl,
            message: `OpenRouter request timed out after ${config.fetchTimeoutMs}ms.`,
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
