import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Modality, ModelPricing } from "../core/types.js";

/**
 * Runtime-introspectable schemas. `tokenomics schema <name>` dumps these as JSON
 * Schema so an agent can discover exactly what the CLI accepts and returns right
 * now, without spending tokens on external docs.
 */

const searchInput = z.object({
  query: z.string().optional().describe("Free-text match against model id, display name, or provider."),
  provider: z.string().optional().describe("Restrict to one provider id, e.g. 'openai'."),
  modality: Modality.optional(),
  "max-input": z.number().optional().describe("Max input price (USD per 1M tokens)."),
  "max-output": z.number().optional().describe("Max output price (USD per 1M tokens)."),
  "min-context": z.number().int().optional().describe("Minimum context window in tokens."),
  limit: z.number().int().default(20),
  offset: z.number().int().default(0),
});

const getInput = z.object({
  model: z.string().describe("Model id or name, e.g. 'openai/gpt-4o' or 'claude opus'."),
  provider: z.string().optional(),
});

const estimateInput = z.object({
  model: z.string(),
  "input-tokens": z.number().int().nonnegative(),
  "output-tokens": z.number().int().nonnegative(),
  "cached-input-tokens": z.number().int().nonnegative().optional(),
  requests: z.number().int().positive().default(1),
});

const compareInput = z.object({
  models: z.string().describe("Comma-separated model ids/names, e.g. 'openai/gpt-4o,anthropic/claude-3.5-sonnet'."),
  "input-tokens": z.number().int().nonnegative(),
  "output-tokens": z.number().int().nonnegative(),
  "cached-input-tokens": z.number().int().nonnegative().optional(),
  requests: z.number().int().positive().default(1),
});

export const SCHEMA_REGISTRY: Record<string, z.ZodTypeAny> = {
  "model-pricing": ModelPricing,
  search: searchInput,
  get: getInput,
  estimate: estimateInput,
  compare: compareInput,
};

export function dumpSchema(name?: string): unknown {
  if (!name) {
    return {
      schemas: Object.keys(SCHEMA_REGISTRY),
      hint: "Run 'tokenomics schema <name>' for a specific JSON Schema.",
    };
  }
  const schema = SCHEMA_REGISTRY[name];
  if (!schema) {
    return {
      error: true,
      code: "UNKNOWN_SCHEMA",
      message: `No schema '${name}'.`,
      available: Object.keys(SCHEMA_REGISTRY),
    };
  }
  return zodToJsonSchema(schema, name);
}
