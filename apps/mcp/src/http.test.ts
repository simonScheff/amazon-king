import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "@amazon-king/database";
import { hashToken, serveHttp } from "./http.js";
import { buildMcpServer } from "./server.js";
import type { ReadService } from "@amazon-king/read-service";
import type { McpWriteService } from "./write-service.js";

/**
 * HTTP transport tests (docs/mcp-server-plan.md W3): bearer-token auth, scope
 * and revocation checks, per-token rate limiting, and audit writes. The pool
 * is stubbed to pattern-match the token and audit queries.
 */

const TOKEN = "akmcp_test-token";
const TOKEN_ROW = {
  id: "7",
  workspace_id: "workspace-1",
  label: "ci-agent",
  scopes: ["mcp:read"],
  created_at: "2026-08-23T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};

const DRAFT_TOKEN = "akmcp_draft-token";
const DRAFT_TOKEN_ROW = {
  id: "8",
  workspace_id: "workspace-1",
  label: "draft-agent",
  scopes: ["mcp:read", "mcp:draft"],
  created_at: "2026-08-23T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};

function fakePool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from api_tokens")) {
      let match: Array<typeof TOKEN_ROW> = [];
      if (params[0] === hashToken(TOKEN)) match = [TOKEN_ROW];
      else if (params[0] === hashToken(DRAFT_TOKEN)) match = [DRAFT_TOKEN_ROW];
      return { rows: match, rowCount: match.length };
    }
    if (sql.includes("update api_tokens")) return { rows: [], rowCount: 1 };
    if (sql.includes("insert into audit_events")) {
      return { rows: [{}], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

function fakeRead(): ReadService {
  return {
    listBooks: vi.fn(async () => [{ id: "book-1", title: "A Novel" }]),
    listProfiles: vi.fn(async () => []),
    listSyncRuns: vi.fn(async () => []),
    dataFreshness: vi.fn(async () => ({ profiles: [], fxRates: null })),
  } as unknown as ReadService;
}

function fakeWrite(): McpWriteService {
  return {
    createRecommendationChangeSet: vi.fn(),
    createCampaignNegativesChangeSet: vi.fn(),
    createSearchTermExclusion: vi.fn(),
    setCampaignMaxCpc: vi.fn(async () => ({ maxCpc: "0.36" })),
    updateCampaignState: vi.fn(),
    addKeywordsToCampaign: vi.fn(),
    setCampaignPlacementMultiplier: vi.fn(),
    rejectRecommendation: vi.fn(),
  };
}

describe("MCP HTTP transport", () => {
  let server: Awaited<ReturnType<typeof serveHttp>>;
  let query: ReturnType<typeof vi.fn>;
  let baseUrl: string;

  beforeEach(async () => {
    const fake = fakePool();
    query = fake.query;
    server = await serveHttp({
      config: {
        databaseUrl: "postgres://unused",
        killSwitch: false,
        transport: "http",
        host: "127.0.0.1",
        port: 0,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pool: fake.pool,
      workspaceId: "workspace-1",
      buildServer: (opts) =>
        buildMcpServer({
          read: fakeRead(),
          write: opts?.canDraft ? fakeWrite() : undefined,
          workspaceId: "workspace-1",
        }),
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function post(headers: Record<string, string> = {}) {
    return fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_books", arguments: {} },
      }),
    });
  }

  it("rejects other paths and methods", async () => {
    const wrong = await fetch(`${baseUrl}x`, { method: "POST" });
    expect(wrong.status).toBe(404);
    const get = await fetch(baseUrl, { method: "GET" });
    expect(get.status).toBe(404);
  });

  it("rejects a missing bearer token with 401", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects an unknown or revoked token with 403", async () => {
    const res = await post({ authorization: "Bearer akmcp_wrong" });
    expect(res.status).toBe(403);
  });

  it("serves a tool call with a valid token and audits it", async () => {
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(body.result.content[0]!.text)).toEqual([
      { id: "book-1", title: "A Novel" },
    ]);

    const auditCalls = query.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).includes("insert into audit_events"),
    );
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]![1]).toEqual([
      "workspace-1",
      null,
      "mcp.tool_call",
      "mcp_tool",
      "list_books",
      expect.anything(),
      null,
      JSON.stringify({ actor: "mcp:ci-agent" }),
    ]);
  });

  it("restricts write tools to tokens with mcp:draft scope", async () => {
    // Calling a write tool with read-only token fails with tool not found
    const readOnlyRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "set_campaign_max_cpc",
          arguments: { campaignId: "c1", maxCpc: "0.36" },
        },
      }),
    });
    const readOnlyBody = await readOnlyRes.json();
    expect(readOnlyBody).toMatchObject({
      result: {
        isError: true,
        content: [
          expect.objectContaining({
            text: expect.stringContaining(
              "Tool set_campaign_max_cpc not found",
            ),
          }),
        ],
      },
    });

    // Calling a write tool with draft token succeeds
    const draftRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${DRAFT_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "set_campaign_max_cpc",
          arguments: { campaignId: "c1", maxCpc: "0.36" },
        },
      }),
    });
    expect(draftRes.status).toBe(200);
    const draftBody = (await draftRes.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(draftBody.result.content[0]!.text)).toMatchObject({
      success: true,
      result: { maxCpc: "0.36" },
    });
  });

  it("rate-limits a token after 120 requests per minute", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 121; i += 1) {
      last = await post({ authorization: `Bearer ${TOKEN}` });
    }
    expect(last!.status).toBe(429);
  }, 30_000);
});
