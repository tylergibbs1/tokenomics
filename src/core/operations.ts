import { Effect } from "effect";
import { ModelNotFoundError } from "./errors.js";
import { OpenRouter } from "./openrouter.js";
import {
  estimateCost,
  findModel,
  searchModels,
  type CostEstimate,
  type CostInput,
  type SearchParams,
  type SearchResult,
} from "./query.js";
import type { ModelPricing } from "./types.js";

/**
 * High-level operations shared by the CLI and the MCP server. Each fetches the live
 * model list from OpenRouter (cached briefly in-process) and runs a pure query, so
 * both surfaces get identical behavior and error types.
 */

export const searchOp = (params: SearchParams) =>
  Effect.gen(function* () {
    const or = yield* OpenRouter;
    const models = yield* or.models;
    return searchModels(models, params);
  });

export const getModelOp = (query: string, provider?: string) =>
  Effect.gen(function* () {
    const or = yield* OpenRouter;
    const models = yield* or.models;
    const result = findModel(models, query, provider);
    if (!result.match) {
      return yield* new ModelNotFoundError({ query, suggestions: result.candidates });
    }
    return result.match;
  });

export const estimateOp = (query: string, cost: CostInput, provider?: string) =>
  Effect.gen(function* () {
    const model = yield* getModelOp(query, provider);
    return estimateCost(model, cost);
  });

export interface CompareResult {
  workload: CostInput;
  ranked: CostEstimate[];
  cheapest?: string;
  unresolved: { query: string; suggestions: string[] }[];
}

export const compareOp = (models: ReadonlyArray<string>, cost: CostInput) =>
  Effect.gen(function* () {
    const or = yield* OpenRouter;
    const all = yield* or.models;

    const ranked: CostEstimate[] = [];
    const unresolved: { query: string; suggestions: string[] }[] = [];
    for (const q of models) {
      const match = findModel(all, q);
      if (match.match) ranked.push(estimateCost(match.match, cost));
      else unresolved.push({ query: q, suggestions: match.candidates });
    }
    ranked.sort((a, b) => a.total_usd - b.total_usd);
    return {
      workload: cost,
      ranked,
      cheapest: ranked[0] ? ranked[0].model_id : undefined,
      unresolved,
    } satisfies CompareResult;
  });

export interface ProviderStatus {
  provider: string;
  model_count: number;
  cheapest_input_per_mtok: number | null;
}

/** Distinct providers present in the live data, with model counts. */
export const providersOp = () =>
  Effect.gen(function* () {
    const or = yield* OpenRouter;
    const all = yield* or.models;
    const byProvider = new Map<string, ModelPricing[]>();
    for (const m of all) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()]
      .map(
        ([provider, list]): ProviderStatus => ({
          provider,
          model_count: list.length,
          cheapest_input_per_mtok: list.reduce<number | null>(
            (min, m) => (min == null ? m.pricing.input_per_mtok : Math.min(min, m.pricing.input_per_mtok)),
            null,
          ),
        }),
      )
      .sort((a, b) => b.model_count - a.model_count);
  });

export type { CostEstimate, SearchResult };
