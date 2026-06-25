/**
 * Output handling for the agent-first CLI. Defaults to JSON whenever stdout is not
 * a TTY (i.e. whenever an agent or pipe is reading), and to a compact table for
 * humans at a terminal. Errors always go to stderr as a machine-readable envelope.
 */

export type OutputFormat = "json" | "ndjson" | "table" | "auto";

export interface OutputOptions {
  format: OutputFormat;
  fields?: string[];
}

export function resolveFormat(format: OutputFormat): "json" | "ndjson" | "table" {
  if (format !== "auto") return format;
  return process.stdout.isTTY ? "table" : "json";
}

/**
 * Apply a field mask. Records (objects with any requested key) are projected to
 * those keys — this covers `get`, which returns one model. Wrapper objects (e.g.
 * search results: `{ models: [...], total, ... }`) have no matching top-level key,
 * so we instead mask the rows inside their array properties and keep the small
 * metadata. Arrays are masked element-wise.
 */
function pick(obj: unknown, fields: string[]): unknown {
  if (Array.isArray(obj)) return obj.map((o) => pick(o, fields));
  if (obj && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const hasRequestedKey = fields.some((f) => f in record);
    if (hasRequestedKey) {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        if (f in record) out[f] = record[f];
      }
      return out;
    }
    // Wrapper object: mask rows inside array properties, keep other values.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = Array.isArray(v) ? v.map((o) => pick(o, fields)) : v;
    }
    return out;
  }
  return obj;
}

export function emit(data: unknown, opts: OutputOptions): void {
  const format = resolveFormat(opts.format);
  const shaped = opts.fields && opts.fields.length > 0 ? pick(data, opts.fields) : data;

  if (format === "ndjson") {
    const rows = Array.isArray(shaped) ? shaped : [shaped];
    for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(shaped, null, 2)}\n`);
    return;
  }
  // table
  process.stdout.write(renderTable(shaped));
}

export function emitError(envelope: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

/** Minimal table renderer for human terminal use; arrays of flat objects only. */
function renderTable(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return "(no rows)\n";
    if (typeof data[0] !== "object" || data[0] === null) return `${data.join("\n")}\n`;
    const cols = Array.from(new Set(data.flatMap((r) => Object.keys(r as object))));
    const widths = cols.map((c) =>
      Math.max(c.length, ...data.map((r) => cell((r as Record<string, unknown>)[c]).length)),
    );
    const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
    const rows = data.map((r) =>
      cols.map((c, i) => cell((r as Record<string, unknown>)[c]).padEnd(widths[i])).join("  "),
    );
    return `${header}\n${rows.join("\n")}\n`;
  }
  if (data && typeof data === "object") {
    return `${Object.entries(data)
      .map(([k, v]) => `${k}: ${cell(v)}`)
      .join("\n")}\n`;
  }
  return `${String(data)}\n`;
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
