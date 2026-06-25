#!/usr/bin/env node
import { buildCli } from "../cli/index.js";

const program = buildCli();
program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ error: true, code: "FATAL", message: err instanceof Error ? err.message : String(err) }, null, 2)}\n`,
  );
  process.exit(1);
});
