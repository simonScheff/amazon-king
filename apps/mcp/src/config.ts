import { z } from "zod";

/**
 * Runtime configuration for the MCP server (docs/mcp-server-plan.md).
 * Read-only machine access to the workspace data; secrets come from the
 * deployment environment, same as the API.
 */

const configSchema = z.object({
  databaseUrl: z.url(),
  /** Reported in status payloads; the MCP server never writes regardless. */
  killSwitch: z.boolean().default(true),
  /** stdio for local agent clients; http for remote agents (needs a token). */
  transport: z.enum(["stdio", "http"]).default("stdio"),
  /** HTTP bind address. Localhost by default; expose only behind TLS. */
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().positive().default(3100),
});

export type McpConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  return configSchema.parse({
    databaseUrl: env.DATABASE_URL,
    killSwitch:
      env.KILL_SWITCH === undefined ? undefined : env.KILL_SWITCH !== "false",
    transport: env.MCP_TRANSPORT || undefined,
    host: env.MCP_HOST || undefined,
    port: env.MCP_PORT ? Number(env.MCP_PORT) : undefined,
  });
}
