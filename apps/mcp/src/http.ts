import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { apiTokens, audit, type Pool } from "@amazon-king/database";
import type { ReadServiceLogger } from "@amazon-king/read-service";
import type { McpConfig } from "./config.js";

/**
 * Streamable HTTP transport for remote agents (docs/mcp-server-plan.md D2/D3).
 * Stateless (no MCP session state): every POST /mcp is authenticated on its
 * own with an owner-issued machine token and served by a fresh server
 * instance. Off by default; bind stays on localhost unless configured.
 */

const MCP_SCOPE = "mcp:read";
/** Per-token request budget, aligned with the API's preview rate. */
const RATE_LIMIT_PER_MINUTE = 120;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

interface RateBucket {
  count: number;
  resetAt: number;
}

export interface ServeHttpDeps {
  config: McpConfig;
  logger: ReadServiceLogger;
  pool: Pool;
  workspaceId: string;
  buildServer: () => McpServer;
  /** Injectable for tests. */
  now?: () => number;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function serveHttp(
  deps: ServeHttpDeps,
): Promise<ReturnType<typeof createServer>> {
  const { config, logger, pool, workspaceId, buildServer } = deps;
  const now = deps.now ?? Date.now;
  const buckets = new Map<string, RateBucket>();

  const httpServer = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/mcp") {
        send(res, 404, { error: "Not found" });
        return;
      }

      const header = req.headers.authorization;
      const presented =
        header?.startsWith("Bearer ") && header.length > 7
          ? header.slice(7).trim()
          : null;
      if (!presented) {
        res.writeHead(401, { "www-authenticate": "Bearer" });
        res.end(JSON.stringify({ error: "Missing bearer token" }));
        return;
      }

      // Lookup is by the full unique SHA-256 hash; hashes are high-entropy,
      // so the index probe leaks nothing about partial prefixes.
      const token = await apiTokens.findActiveApiTokenByHash(
        pool,
        hashToken(presented),
      );
      if (!token || !token.scopes.includes(MCP_SCOPE)) {
        send(res, 403, { error: "Invalid or revoked token" });
        return;
      }
      void apiTokens.touchApiToken(pool, token.id).catch(() => {});

      const bucket = buckets.get(token.id);
      const at = now();
      if (!bucket || bucket.resetAt <= at) {
        buckets.set(token.id, { count: 1, resetAt: at + 60_000 });
      } else if (bucket.count >= RATE_LIMIT_PER_MINUTE) {
        send(res, 429, { error: "Rate limit exceeded" });
        return;
      } else {
        bucket.count += 1;
      }

      const body = (await readBody(req)) as
        { method?: string; params?: { name?: string } } | undefined;

      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // Plain JSON responses: this server answers request/response tool
        // calls only and never streams notifications.
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);

      if (body?.method === "tools/call") {
        await audit
          .insertAuditEvent(pool, {
            workspaceId,
            event: "mcp.tool_call",
            entityType: "mcp_tool",
            entityId: body.params?.name ?? null,
            ip: req.socket.remoteAddress ?? null,
            details: { actor: `mcp:${token.label}` },
          })
          .catch((error) => logger.warn({ err: error }, "audit write failed"));
      }
    } catch (error) {
      logger.error({ err: error }, "MCP HTTP request failed");
      if (!res.headersSent) send(res, 500, { error: "Internal server error" });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });
  logger.info(
    { host: config.host, port: config.port, workspaceId },
    "MCP server listening over HTTP",
  );
  return httpServer;
}
