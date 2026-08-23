import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPool, identity } from "@amazon-king/database";
import { createLogger } from "@amazon-king/observability";
import { createReadService } from "@amazon-king/read-service";
import { loadConfig } from "./config.js";
import { buildMcpServer } from "./server.js";

/**
 * Composition root for the MCP server (docs/mcp-server-plan.md): stdio for
 * local agent clients (default), Streamable HTTP for remote agents behind a
 * machine token. The server is read-only; applying changes stays in the
 * dashboard.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  // stdio transports the protocol on stdout, so logs must go to stderr.
  const stderrStream = {
    write: (chunk: string) => process.stderr.write(chunk),
  };
  const logger = createLogger("mcp", {}, stderrStream);
  const pool = createPool(config.databaseUrl);

  const workspaceId = await identity.getSingleWorkspaceId(pool);
  if (!workspaceId) {
    throw new Error(
      "No workspace found — sign in to the dashboard once before starting the MCP server",
    );
  }

  const read = createReadService({
    db: pool,
    config: { killSwitch: config.killSwitch },
    logger,
  });
  const buildServer = () => buildMcpServer({ read, workspaceId });

  const shutdown = async () => {
    await pool.end();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  if (config.transport === "http") {
    const { serveHttp } = await import("./http.js");
    await serveHttp({ config, logger, pool, workspaceId, buildServer });
  } else {
    await buildServer().connect(new StdioServerTransport());
    logger.info({ workspaceId }, "MCP server connected over stdio");
  }
}

main().catch((error) => {
  console.error("MCP server failed to start", error);
  process.exit(1);
});
