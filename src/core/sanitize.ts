/**
 * Input hardening for the CLI/MCP boundary. Agents fail differently than humans:
 * they hallucinate path segments, embed query params in ids, and emit control
 * characters. We validate at the boundary instead of trusting the schema.
 */

export class ValidationError extends Error {
  code: string;
  suggestion?: string;
  constructor(code: string, message: string, suggestion?: string) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
  }
}

// Matching control characters is the whole point here — agents emit invisible
// chars that we reject at the boundary.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/** Reject control characters anywhere in a free-text string. */
export function assertNoControlChars(value: string, field: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new ValidationError(
      "INVALID_INPUT",
      `Field '${field}' contains control characters.`,
      "Remove invisible/control characters (anything below ASCII 0x20).",
    );
  }
}

/**
 * Validate an identifier such as a model id or provider id. Rejects the agent
 * failure modes from the building-agent-clis skill: embedded query params (?, #),
 * pre-encoding (%), path traversal, and control chars.
 */
export function sanitizeId(value: string, field: string): string {
  const v = value.trim();
  if (v.length === 0) {
    throw new ValidationError("INVALID_INPUT", `Field '${field}' must not be empty.`);
  }
  if (v.length > 200) {
    throw new ValidationError("INVALID_INPUT", `Field '${field}' is too long (max 200 chars).`);
  }
  assertNoControlChars(v, field);
  for (const bad of ["?", "#", "%", "..", "/", "\\"]) {
    if (v.includes(bad)) {
      throw new ValidationError(
        "INVALID_RESOURCE_ID",
        `Field '${field}' contains invalid sequence '${bad}'.`,
        "Model and provider ids are plain identifiers — strip query params, URL encoding, and path separators.",
      );
    }
  }
  return v;
}

/** Free-text search queries are more permissive but still reject control chars + over-long input. */
export function sanitizeQuery(value: string, field = "query"): string {
  const v = value.trim();
  if (v.length > 500) {
    throw new ValidationError("INVALID_INPUT", `Field '${field}' is too long (max 500 chars).`);
  }
  assertNoControlChars(v, field);
  return v;
}
