import { Command } from "commander";
import { Cause, Effect, Exit } from "effect";
import { errorEnvelope, InputError, type TokenomicsError } from "../core/errors.js";
import { compareOp, estimateOp, getModelOp, providersOp, searchOp } from "../core/operations.js";
import type { AppServices } from "../core/runtime.js";
import { runExit } from "../core/runtime.js";
import { sanitizeId, sanitizeQuery, ValidationError } from "../core/sanitize.js";
import { Modality } from "../core/types.js";
import { emit, emitError, type OutputFormat } from "./output.js";
import { dumpSchema } from "./schemas.js";

interface GlobalOpts {
  output: OutputFormat;
  fields?: string[];
}

function outputOpts(cmd: Command): { format: OutputFormat; fields?: string[] } {
  const g = cmd.optsWithGlobals() as GlobalOpts;
  return { format: g.output ?? "auto", fields: g.fields };
}

/** Run an effect and emit JSON/table on success or a machine-readable error on failure. */
async function runAndEmit<A>(
  effect: Effect.Effect<A, TokenomicsError, AppServices>,
  out: { format: OutputFormat; fields?: string[] },
): Promise<void> {
  const exit = await runExit(effect);
  if (Exit.isSuccess(exit)) {
    emit(exit.value, out);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    emitError(errorEnvelope(failure.value));
  } else {
    emitError({ error: true, code: "INTERNAL_ERROR", message: Cause.pretty(exit.cause) });
  }
  process.exitCode = 1;
}

/** Parse a numeric option, rejecting agent-style malformed values with an actionable error. */
function num(value: string | undefined, field: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ValidationError("INVALID_INPUT", `Field '${field}' must be a number. Received: '${value}'`);
  }
  return n;
}

function intOpt(value: string | undefined, field: string): number | undefined {
  const n = num(value, field);
  if (n == null) return undefined;
  if (!Number.isInteger(n)) {
    throw new ValidationError("INVALID_INPUT", `Field '${field}' must be an integer. Received: '${value}'`);
  }
  return n;
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name("tokenomics")
    .description(
      "Fresh, live LLM pricing for agents (CLI + MCP), sourced from the OpenRouter Models API. Prices are USD per 1M tokens.",
    )
    .version("0.1.0")
    .option("-o, --output <format>", "output format: json | ndjson | table | auto (default: json when piped)", "auto")
    .option("--fields <list>", "comma-separated field mask to limit response size", (v) =>
      v.split(",").map((s) => s.trim()),
    );

  // Wrap actions so thrown ValidationErrors become machine-readable errors, not stack traces.
  const guard =
    (fn: (cmd: Command) => Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      const cmd = args[args.length - 1] as Command;
      try {
        await fn(cmd);
      } catch (e) {
        if (e instanceof ValidationError) {
          emitError(errorEnvelope(new InputError({ code: e.code, message: e.message, suggestion: e.suggestion })));
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    };

  program
    .command("search")
    .description("Search models across providers, filtered by price/modality/context, cheapest input first.")
    .argument("[query]", "free-text match on id, name, or provider")
    .option("--provider <id>", "restrict to one provider id, e.g. 'openai'")
    .option("--modality <modality>", "text|multimodal|embedding|image|audio|video|reranker|other")
    .option("--max-input <usd>", "max input price, USD per 1M tokens")
    .option("--max-output <usd>", "max output price, USD per 1M tokens")
    .option("--min-context <tokens>", "minimum context window")
    .option("--limit <n>", "page size (default 20)", "20")
    .option("--offset <n>", "page offset (default 0)", "0")
    .action(
      guard(async (cmd) => {
        const o = cmd.opts();
        const query = cmd.args[0] ? sanitizeQuery(cmd.args[0]) : undefined;
        const modality = o.modality ? Modality.parse(o.modality) : undefined;
        await runAndEmit(
          searchOp({
            query,
            provider: o.provider ? sanitizeId(o.provider, "provider") : undefined,
            modality,
            maxInputPerMtok: num(o.maxInput, "max-input"),
            maxOutputPerMtok: num(o.maxOutput, "max-output"),
            minContextWindow: intOpt(o.minContext, "min-context"),
            limit: intOpt(o.limit, "limit") ?? 20,
            offset: intOpt(o.offset, "offset") ?? 0,
          }),
          outputOpts(cmd),
        );
      }),
    );

  program
    .command("get")
    .description("Get full pricing for one model by id or name.")
    .argument("<model>", "model id or name, e.g. 'openai/gpt-4o'")
    .option("--provider <id>", "disambiguate by provider id")
    .action(
      guard(async (cmd) => {
        const o = cmd.opts();
        const model = sanitizeQuery(cmd.args[0], "model");
        await runAndEmit(
          getModelOp(model, o.provider ? sanitizeId(o.provider, "provider") : undefined),
          outputOpts(cmd),
        );
      }),
    );

  program
    .command("estimate")
    .description("Estimate USD cost of a workload on one model.")
    .argument("<model>", "model id or name")
    .requiredOption("--input-tokens <n>", "input tokens per request")
    .requiredOption("--output-tokens <n>", "output tokens per request")
    .option("--cached-input-tokens <n>", "cached input tokens per request")
    .option("--requests <n>", "number of requests (default 1)", "1")
    .action(
      guard(async (cmd) => {
        const o = cmd.opts();
        const model = sanitizeQuery(cmd.args[0], "model");
        await runAndEmit(
          estimateOp(model, {
            inputTokens: intOpt(o.inputTokens, "input-tokens") ?? 0,
            outputTokens: intOpt(o.outputTokens, "output-tokens") ?? 0,
            cachedInputTokens: intOpt(o.cachedInputTokens, "cached-input-tokens"),
            requests: intOpt(o.requests, "requests") ?? 1,
          }),
          outputOpts(cmd),
        );
      }),
    );

  program
    .command("compare")
    .description("Rank models by total cost for the same workload, cheapest first.")
    .requiredOption("--models <list>", "comma-separated model ids/names")
    .requiredOption("--input-tokens <n>", "input tokens per request")
    .requiredOption("--output-tokens <n>", "output tokens per request")
    .option("--cached-input-tokens <n>", "cached input tokens per request")
    .option("--requests <n>", "number of requests (default 1)", "1")
    .action(
      guard(async (cmd) => {
        const o = cmd.opts();
        const models = String(o.models)
          .split(",")
          .map((s) => sanitizeQuery(s, "models"))
          .filter((s) => s.length > 0);
        await runAndEmit(
          compareOp(models, {
            inputTokens: intOpt(o.inputTokens, "input-tokens") ?? 0,
            outputTokens: intOpt(o.outputTokens, "output-tokens") ?? 0,
            cachedInputTokens: intOpt(o.cachedInputTokens, "cached-input-tokens"),
            requests: intOpt(o.requests, "requests") ?? 1,
          }),
          outputOpts(cmd),
        );
      }),
    );

  program
    .command("providers")
    .description("List providers present in the live data with model counts.")
    .action(
      guard(async (cmd) => {
        await runAndEmit(providersOp(), outputOpts(cmd));
      }),
    );

  program
    .command("schema")
    .description("Print the JSON Schema for a command's input or for the model-pricing record (runtime introspection).")
    .argument("[name]", "schema name: search|get|estimate|compare|model-pricing")
    .action((name: string | undefined) => {
      emit(dumpSchema(name), { format: "json" });
    });

  program
    .command("mcp")
    .description("Start the tokenomics MCP server over stdio.")
    .action(async () => {
      const { startStdioServer } = await import("../mcp/server.js");
      await startStdioServer();
    });

  return program;
}
