import { Context, Layer } from "effect";

/**
 * Runtime configuration from environment variables, so the tool works in headless
 * agent environments with zero interactive setup. Pricing comes live from the
 * models.dev catalog on every call; the only "state" is a short in-process cache.
 */
export interface Config {
  /** models.dev catalog endpoint (returns all providers + models + pricing). It is public — no key required. */
  modelsApiUrl: string;
  /**
   * Seconds to reuse a fetched models list within one process. Data stays live
   * (at most this old) while avoiding a re-download of the full catalog for every
   * call in a single MCP session. Set 0 to fetch fresh on every call.
   */
  cacheTtlSeconds: number;
  /** Hard timeout for the models.dev request, so a hung network never hangs a tool call. */
  fetchTimeoutMs: number;
  /**
   * When true, a model lookup miss is a hard error (MODEL_NOT_FOUND). When false
   * (default), get_model_pricing returns matched:false with candidates instead — the
   * MCP-recommended "don't frame as not-found" behavior for agent callers.
   */
  strictModelLookup: boolean;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(): Config {
  return {
    modelsApiUrl: process.env.MODELS_DEV_API_URL || "https://models.dev/api.json",
    cacheTtlSeconds: envInt("TOKENOMICS_CACHE_TTL_SECONDS", 60),
    fetchTimeoutMs: envInt("TOKENOMICS_FETCH_TIMEOUT_MS", 15000),
    strictModelLookup: envBool("TOKENOMICS_STRICT_LOOKUP", false),
  };
}

/**
 * Effect service wrapper around {@link Config}. Services depend on `AppConfig`
 * rather than reading `process.env` directly, which keeps them testable.
 */
export class AppConfig extends Context.Tag("AppConfig")<AppConfig, Config>() {}

export const AppConfigLive = Layer.sync(AppConfig, loadConfig);

/** Build a fixed-value config layer, e.g. for tests. */
export const appConfigFrom = (config: Config): Layer.Layer<AppConfig> => Layer.succeed(AppConfig, config);
