import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPool, identity } from "@amazon-king/database";
import { createLogger } from "@amazon-king/observability";
import { createReadService } from "@amazon-king/read-service";
import { loadConfig } from "./config.js";
import { buildMcpServer } from "./server.js";
import { createMcpWriteService } from "./write-service.js";

/**
 * Composition root for the MCP server: stdio for local agent clients (default),
 * Streamable HTTP for remote agents behind a machine token.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  // stdio transports the protocol on stdout, so logs must go to stderr.
  const stderrStream = {
    write: (chunk: string) => process.stderr.write(chunk),
  };
  const logger = createLogger("mcp", {}, stderrStream);
  const pool = createPool(config.databaseUrl);

  let cachedWorkspaceId: string | null = null;
  const getWorkspaceId = async () => {
    if (cachedWorkspaceId) return cachedWorkspaceId;
    const wsId = await identity.getSingleWorkspaceId(pool);
    if (!wsId) {
      throw new Error(
        "No workspace found — sign in to the dashboard once before starting the MCP server",
      );
    }
    cachedWorkspaceId = wsId;
    return wsId;
  };

  const read = createReadService({
    db: pool,
    config: { killSwitch: config.killSwitch },
    logger,
  });
  const write = config.killSwitch ? undefined : createMcpWriteService(pool);
  const buildServer = (opts?: { canDraft?: boolean }) =>
    buildMcpServer({
      read,
      write: (opts?.canDraft ?? true) ? write : undefined,
      workspaceId: getWorkspaceId,
    });

  const shutdown = async () => {
    await pool.end();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  if (config.transport === "http") {
    const workspaceId = await getWorkspaceId();
    const { serveHttp } = await import("./http.js");
    await serveHttp({ config, logger, pool, workspaceId, buildServer });
  } else {
    await buildServer().connect(new StdioServerTransport());
    logger.info("MCP server connected over stdio");
  }
}

main().catch((error) => {
  console.error("MCP server failed to start", error);
  process.exit(1);
});
