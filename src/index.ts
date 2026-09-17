#!/usr/bin/env node
/**
 * Entrypoint: stdio transport only for V1 (spec §2). Streamable HTTP can be
 * added later by constructing a different transport around the same
 * `buildServer()` McpServer instance — no tool/db logic needs to change.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, redactedForLogging } from "./config/index.js";
import { buildServer } from "./server.js";
import { log, setLogLevel } from "./logging/audit.js";
import { closePool } from "./db/pool.js";

async function main() {
  const config = loadConfig();
  setLogLevel(config.logging.level);
  log.info("starting sqlserver-review-mcp", { config: redactedForLogging(config) });

  const { server, capabilities } = await buildServer(config);
  log.info("tools registered", { capabilities });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("connected via stdio transport");

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    try {
      await closePool();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(JSON.stringify({ level: "error", msg: "fatal startup error", error: message }) + "\n");
  process.exit(1);
});
