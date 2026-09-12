/**
 * Machine-token CLI for the MCP server's HTTP transport
 * (docs/mcp-server-plan.md D3). Tokens are SHA-256 hashed before storage; the
 * plaintext is printed exactly once at issuance.
 *
 * Usage (from the repo root, DATABASE_URL set):
 *   pnpm exec tsx scripts/mcp-token.ts issue <label>
 *   pnpm exec tsx scripts/mcp-token.ts list
 *   pnpm exec tsx scripts/mcp-token.ts revoke <id>
 */
import { createHash, randomBytes } from "node:crypto";
import { apiTokens, createPool, identity } from "@amazon-king/database";

/** SHA-256 hex of a presented token; must match apps/mcp/src/http.ts. */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const args = process.argv.slice(2);
const command = args[0];
const labelOrId = args.find((a) => !a.startsWith("--") && a !== command);
const isDraft = args.includes("--draft");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set (copy .env.example to .env first)");
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  const workspaceId = await identity.getSingleWorkspaceId(pool);
  if (!workspaceId) {
    console.error("No workspace found — sign in to the dashboard once first");
    process.exit(1);
  }

  switch (command) {
    case "issue": {
      if (!labelOrId) {
        console.error("Usage: mcp-token.ts issue <label> [--draft]");
        process.exit(1);
      }
      const scopes = isDraft ? ["mcp:read", "mcp:draft"] : ["mcp:read"];
      const token = `akmcp_${randomBytes(32).toString("base64url")}`;
      const row = await apiTokens.createApiToken(pool, {
        workspaceId,
        label: labelOrId,
        tokenHash: hashToken(token),
        scopes,
      });
      console.log(
        `Issued token ${row.id} (${row.label}) [${row.scopes.join(", ")}]. Store it now — it is shown only once:`,
      );
      console.log(token);
      break;
    }
    case "list": {
      const rows = await apiTokens.listApiTokens(pool, workspaceId);
      for (const row of rows) {
        const state = row.revokedAt ? `revoked ${row.revokedAt}` : "active";
        console.log(
          `${row.id}\t${row.label}\t${row.scopes.join(",")}\t${state}\tlast used ${row.lastUsedAt ?? "never"}`,
        );
      }
      break;
    }
    case "revoke": {
      if (!arg) {
        console.error("Usage: mcp-token.ts revoke <id>");
        process.exit(1);
      }
      const ok = await apiTokens.revokeApiToken(pool, workspaceId, arg);
      console.log(ok ? `Revoked token ${arg}.` : `No active token ${arg}.`);
      process.exitCode = ok ? 0 : 1;
      break;
    }
    default:
      console.error("Usage: mcp-token.ts issue <label> | list | revoke <id>");
      process.exit(1);
  }
} finally {
  await pool.end();
}
