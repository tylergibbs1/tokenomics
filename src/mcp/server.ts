import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";
import { errorEnvelope, type TokenomicsError } from "../core/errors.js";
import { loadConfig } from "../core/config.js";
import { compareOp, estimateOp, getModelOp, searchOp } from "../core/operations.js";
import { makeRuntime, type AppServices } from "../core/runtime.js";
import { Modality } from "../core/types.js";

/**
 * MCP surface. Four workflow-level tools (not CRUD wrappers): each maps to a real
 * agent intent and bundles the live models.dev fetch + matching + math so an agent
 * needs one call, not three. All tools are read-only; prices are fetched live from
 * models.dev (cached briefly in-process), so there is no separate refresh action.
 */

const INSTRUCTIONS = `tokenomics provides fresh, live pricing for LLMs from the models.dev catalog.

WHAT THIS SERVER IS FOR
Answer questions about LLM API prices and the cost of running a workload on a model:
which model is cheapest, what a given prompt/output volume will cost, and how
candidate models compare. Data is fetched live on every call (briefly cached
in-process), so it always reflects current models.dev pricing.

UNITS — read before using results
- Every price field is USD per 1,000,000 tokens. A value of 2.5 means $2.50 per 1M tokens.
- estimate_cost / compare_models take RAW token counts (e.g. 1000000), not millions.
- output_per_mtok = null means the model is non-generative (embeddings/rerankers); its
  output tokens cost $0.
- The same model is often served by several providers at different prices. Model ids are
  'provider/model' where provider is the SERVING provider, e.g. 'openai/gpt-4o',
  'anthropic/claude-3.5-sonnet', 'requesty/xai/grok-4'.

CHOOSING A TOOL
- Discover / "what's cheap / which models exist" → search_models (filter, sorted cheapest-input first).
- One known model's full pricing → get_model_pricing.
- "How much will X cost on model Y" → estimate_cost (it does the per-million math for you).
- "Which of these is cheaper for my workload" → compare_models (ranks candidates).

BEST PRACTICES
1. Resolve a real model id with search_models before calling get/estimate; do not invent ids.
2. Never compute prices yourself from raw rates — call estimate_cost / compare_models so units are handled correctly.
3. If get_model_pricing returns matched:false, use the returned candidates or call search_models; do not guess.
4. Prefer narrowing search_models with filters (provider, modality, max_input_per_mtok) over paging large lists.`;

const SEARCH_DESC = `<use_case>Discover and shortlist LLM models across providers — e.g. "cheapest text model under $1/M input with >=128k context", or "what embedding models exist".</use_case>
<important_notes>Results are sorted cheapest-input first and paginated (offset/limit). Prices are USD per 1M tokens, fetched live. Narrow with provider/modality/max_input_per_mtok rather than paging huge lists.</important_notes>`;

const GET_DESC = `<use_case>Get one model's full pricing, context window, and provenance when you already know roughly which model you want (by id or name).</use_case>
<important_notes>Returns { matched: true, model } on a hit, or { matched: false, candidates } when the name is ambiguous or unknown — pick a candidate or call search_models. Prices are USD per 1M tokens.</important_notes>`;

const ESTIMATE_DESC = `<use_case>Compute the USD cost ("how much will this cost", "price this prompt") of a workload on one model: input/output/cached token counts times a request count.</use_case>
<important_notes>Token counts are RAW integers (1000000, not 1). Bundles model lookup and the per-million math; do not compute prices yourself. Cached tokens use the model's cached-input rate when available.</important_notes>`;

const COMPARE_DESC = `<use_case>Decide which model is cheapest for a specific workload — rank several candidates by total USD cost for the same token volumes.</use_case>
<important_notes>Returns models ranked cheapest-first plus any unresolved names (with suggestions). Token counts are RAW integers.</important_notes>`;

export function buildServer(): McpServer {
  const server = new McpServer({ name: "tokenomics", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  // One runtime (and in-process model cache) for the whole process lifetime.
  const runtime = makeRuntime();
  const { strictModelLookup } = loadConfig();

  // Run an op, turning typed failures into the standard machine-readable envelope.
  const run = async <A>(effect: Effect.Effect<A, TokenomicsError, AppServices>) => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) {
      return ok(exit.value);
    }
    const failure = Cause.failureOption(exit.cause);
    return err(
      failure._tag === "Some"
        ? errorEnvelope(failure.value)
        : { error: true, code: "INTERNAL_ERROR", message: Cause.pretty(exit.cause) },
    );
  };

  server.registerTool(
    "search_models",
    {
      title: "Search LLM models by price and capability",
      description: SEARCH_DESC,
      inputSchema: {
        query: z.string().optional().describe("Free-text match on model id, name, or provider."),
        provider: z.string().optional().describe("Restrict to one provider id, e.g. 'openai', 'anthropic'."),
        modality: Modality.optional().describe("Filter by modality, e.g. 'text', 'embedding'."),
        max_input_per_mtok: z.number().nonnegative().optional().describe("Max input price, USD per 1M tokens."),
        max_output_per_mtok: z.number().nonnegative().optional().describe("Max output price, USD per 1M tokens."),
        min_context_window: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      run(
        searchOp({
          query: args.query,
          provider: args.provider,
          modality: args.modality,
          maxInputPerMtok: args.max_input_per_mtok,
          maxOutputPerMtok: args.max_output_per_mtok,
          minContextWindow: args.min_context_window,
          limit: args.limit,
          offset: args.offset,
        }),
      ),
  );

  server.registerTool(
    "get_model_pricing",
    {
      title: "Get pricing for one model",
      description: GET_DESC,
      inputSchema: {
        model: z.string().describe("Model id or name, e.g. 'openai/gpt-4o' or 'claude opus'."),
        provider: z.string().optional().describe("Optional provider id to disambiguate."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runResolve(args.model, args.provider),
  );

  server.registerTool(
    "estimate_cost",
    {
      title: "Estimate cost of a workload on a model",
      description: ESTIMATE_DESC,
      inputSchema: {
        model: z.string(),
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cached_input_tokens: z.number().int().nonnegative().optional(),
        requests: z.number().int().positive().default(1),
        provider: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      run(
        estimateOp(
          args.model,
          {
            inputTokens: args.input_tokens,
            outputTokens: args.output_tokens,
            cachedInputTokens: args.cached_input_tokens,
            requests: args.requests,
          },
          args.provider,
        ),
      ),
  );

  server.registerTool(
    "compare_models",
    {
      title: "Compare models by cost for a workload",
      description: COMPARE_DESC,
      inputSchema: {
        models: z
          .array(z.string())
          .min(2)
          .describe("Model ids/names to compare, e.g. ['openai/gpt-4o','anthropic/claude-3.5-sonnet']."),
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cached_input_tokens: z.number().int().nonnegative().optional(),
        requests: z.number().int().positive().default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      run(
        compareOp(args.models, {
          inputTokens: args.input_tokens,
          outputTokens: args.output_tokens,
          cachedInputTokens: args.cached_input_tokens,
          requests: args.requests,
        }),
      ),
  );

  /**
   * get_model_pricing resolver. Default (soft) behavior follows MCP best practice: a
   * lookup miss is NOT framed as an error — we return matched:false with candidates so
   * the model uses the useful alternatives instead of fixating on a failure. With
   * TOKENOMICS_STRICT_LOOKUP=1, a miss is a hard MODEL_NOT_FOUND error instead, for
   * non-agent callers that want a failing signal. Real faults (network) always error.
   */
  async function runResolve(model: string, provider?: string) {
    const exit = await runtime.runPromiseExit(getModelOp(model, provider));
    if (Exit.isSuccess(exit)) {
      return ok({ matched: true, model: exit.value });
    }
    const failure = Cause.failureOption(exit.cause);
    if (!strictModelLookup && failure._tag === "Some" && failure.value._tag === "ModelNotFoundError") {
      return ok({
        matched: false,
        query: model,
        candidates: failure.value.suggestions,
        hint: "No exact match. Pick one of `candidates`, or call search_models to browse available models.",
      });
    }
    return err(
      failure._tag === "Some"
        ? errorEnvelope(failure.value)
        : { error: true, code: "INTERNAL_ERROR", message: Cause.pretty(exit.cause) },
    );
  }

  return server;
}

function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: asStructured(value),
  };
}

function err(envelope: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }], isError: true };
}

/** MCP structuredContent must be an object; wrap arrays/scalars under a key. */
function asStructured(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { result: value };
}

/** Start the server over stdio (the standard local MCP transport). */
export async function startStdioServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
