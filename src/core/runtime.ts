import { Effect, Layer, ManagedRuntime } from "effect";
import { AppConfigLive } from "./config.js";
import { OpenRouter } from "./openrouter.js";

/**
 * Full dependency graph: the OpenRouter client (which depends on AppConfig).
 * `provideMerge` supplies AppConfig to the service AND re-exports it. The CLI and
 * MCP server share this identical wiring. No database — pricing is fetched live.
 */
export const AppLayer = OpenRouter.Default.pipe(Layer.provideMerge(AppConfigLive));

export type AppServices = Layer.Layer.Success<typeof AppLayer>;

/**
 * A ManagedRuntime lets a long-lived process (the MCP server) build the layer once
 * and reuse it (and its in-process model cache) across many tool calls.
 */
export const makeRuntime = (): ManagedRuntime.ManagedRuntime<AppServices, never> => ManagedRuntime.make(AppLayer);

/** One-shot runner for the CLI: run an effect to an Exit, providing all services. */
export const runExit = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
  Effect.runPromiseExit(Effect.scoped(Effect.provide(effect, AppLayer)));
