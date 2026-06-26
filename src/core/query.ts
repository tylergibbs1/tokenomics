import type { Modality, ModelPricing } from "./types.js";

/** Query functions over a live list of models. Pure — fetching happens in operations.ts. */

export interface SearchParams {
  query?: string;
  provider?: string;
  modality?: Modality;
  maxInputPerMtok?: number;
  maxOutputPerMtok?: number;
  minContextWindow?: number;
  limit: number;
  offset: number;
}

export interface SearchResult {
  models: ModelPricing[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  note?: string;
}

/** Lowercased, space/dash/underscore-insensitive token for fuzzy matching ids and names. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_/-]+/g, "");
}

export function searchModels(all: ReadonlyArray<ModelPricing>, params: SearchParams): SearchResult {
  const q = params.query ? norm(params.query) : undefined;
  const filtered = all.filter((m) => {
    if (params.provider && m.provider !== params.provider.toLowerCase()) return false;
    if (params.modality && m.modality !== params.modality) return false;
    if (params.maxInputPerMtok != null && m.pricing.input_per_mtok > params.maxInputPerMtok) return false;
    if (
      params.maxOutputPerMtok != null &&
      m.pricing.output_per_mtok != null &&
      m.pricing.output_per_mtok > params.maxOutputPerMtok
    )
      return false;
    if (params.minContextWindow != null && (m.context_window ?? 0) < params.minContextWindow) return false;
    if (q) {
      const hay = norm(`${m.model_id} ${m.display_name} ${m.provider}`);
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Cheapest input first — the most common agent intent ("find me a cheap model").
  filtered.sort((a, b) => a.pricing.input_per_mtok - b.pricing.input_per_mtok);

  const total = filtered.length;
  const page = filtered.slice(params.offset, params.offset + params.limit);
  const truncated = total > params.offset + page.length;
  return {
    models: page,
    total,
    offset: params.offset,
    limit: params.limit,
    truncated,
    note: truncated
      ? `Showing ${page.length} of ${total}. Use offset/limit to page, or narrow with provider/modality/max-input filters.`
      : undefined,
  };
}

export interface ModelMatch {
  match?: ModelPricing;
  candidates: string[];
}

/**
 * Resolve a single model from a free-text query. Tries, in order: exact id, exact
 * display name, then substring. Ambiguous queries return candidates so the caller
 * (agent) can disambiguate instead of guessing.
 */
export function findModel(all: ReadonlyArray<ModelPricing>, query: string, provider?: string): ModelMatch {
  const pool = provider ? all.filter((m) => m.provider === provider.toLowerCase()) : all;
  const nq = norm(query);

  // A unique exact id match wins outright. Gateway providers on models.dev often set
  // display_name to the upstream id (e.g. "openai/gpt-4o"), so an id like "openai/gpt-4o"
  // would otherwise tie with those display names; the canonical id is more authoritative.
  const idExact = pool.filter((m) => norm(m.model_id) === nq);
  if (idExact.length === 1) return { match: idExact[0], candidates: [] };

  const exact = pool.filter((m) => norm(m.model_id) === nq || norm(m.display_name) === nq);
  if (exact.length === 1) return { match: exact[0], candidates: [] };

  const partial = pool.filter((m) => norm(`${m.model_id} ${m.display_name}`).includes(nq));
  if (partial.length === 1) return { match: partial[0], candidates: [] };

  const pickFrom = exact.length > 1 ? exact : partial;
  return { candidates: pickFrom.slice(0, 10).map((m) => m.model_id) };
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  requests?: number;
}

export interface CostEstimate {
  model_id: string;
  provider: string;
  per_request_usd: number;
  total_usd: number;
  requests: number;
  breakdown: { input_usd: number; cached_input_usd: number; output_usd: number };
  warnings: string[];
}

const PER_MTOK = 1_000_000;

/** Compute cost for a workload. Pure: takes a resolved model + token counts. */
export function estimateCost(model: ModelPricing, input: CostInput): CostEstimate {
  const requests = input.requests ?? 1;
  const warnings: string[] = [];

  const cachedTokens = input.cachedInputTokens ?? 0;
  const freshInputTokens = Math.max(0, input.inputTokens - cachedTokens);

  const cachedRate = model.pricing.cached_input_per_mtok;
  if (cachedTokens > 0 && cachedRate == null) {
    warnings.push("No cached-input rate known for this model; cached tokens billed at the standard input rate.");
  }
  const effectiveCachedRate = cachedRate ?? model.pricing.input_per_mtok;

  const inputUsd = (freshInputTokens / PER_MTOK) * model.pricing.input_per_mtok;
  const cachedUsd = (cachedTokens / PER_MTOK) * effectiveCachedRate;

  if (model.pricing.output_per_mtok == null && input.outputTokens > 0) {
    warnings.push("Model has no output price (non-generative); output tokens contribute $0.");
  }
  const outputUsd = (input.outputTokens / PER_MTOK) * (model.pricing.output_per_mtok ?? 0);

  const perRequest = inputUsd + cachedUsd + outputUsd;
  return {
    model_id: model.model_id,
    provider: model.provider,
    per_request_usd: round6(perRequest),
    total_usd: round6(perRequest * requests),
    requests,
    breakdown: { input_usd: round6(inputUsd), cached_input_usd: round6(cachedUsd), output_usd: round6(outputUsd) },
    warnings,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
