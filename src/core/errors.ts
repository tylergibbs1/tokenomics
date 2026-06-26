import { Data } from "effect";

/**
 * Domain errors as tagged errors so Effect can route them with `catchTag` and so
 * the CLI/MCP boundary can translate each into a stable machine-readable `code`.
 */

export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string;
  readonly message: string;
  readonly status?: number;
}> {}

export class ModelNotFoundError extends Data.TaggedError("ModelNotFoundError")<{
  readonly query: string;
  readonly suggestions: ReadonlyArray<string>;
}> {}

export class InputError extends Data.TaggedError("InputError")<{
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
}> {}

export type TokenomicsError = FetchError | ModelNotFoundError | InputError;

export function errorCode(e: TokenomicsError): string {
  switch (e._tag) {
    case "FetchError":
      return "FETCH_FAILED";
    case "ModelNotFoundError":
      return "MODEL_NOT_FOUND";
    case "InputError":
      return e.code;
  }
}

/** Build the standard machine-readable error envelope used everywhere agents read output. */
export function errorEnvelope(e: TokenomicsError): {
  error: true;
  code: string;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
} {
  const base = { error: true as const, code: errorCode(e), message: e.message };
  switch (e._tag) {
    case "ModelNotFoundError":
      return {
        ...base,
        message: `No model matching '${e.query}'.`,
        suggestion:
          e.suggestions.length > 0
            ? `Did you mean: ${e.suggestions.join(", ")}?`
            : "Use 'tokenomics search' (or the search_models tool) to list available models.",
        details: { suggestions: e.suggestions },
      };
    case "InputError":
      return { ...base, suggestion: e.suggestion };
    case "FetchError":
      return {
        ...base,
        suggestion: "Check network access to models.dev and MODELS_DEV_API_URL.",
        details: { url: e.url, status: e.status },
      };
  }
}
