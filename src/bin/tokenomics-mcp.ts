#!/usr/bin/env node
import { startStdioServer } from "../mcp/server.js";

// stdio transport: stdout is reserved for JSON-RPC, so all diagnostics go to stderr.
startStdioServer().catch((err: unknown) => {
  process.stderr.write(`tokenomics-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
