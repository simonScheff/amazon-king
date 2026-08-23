import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadService } from "@amazon-king/read-service";
import { buildMcpServer } from "./server.js";

/**
 * Tool-surface tests: the MCP server is driven through a real client over a
 * linked in-memory transport, with a stubbed ReadService underneath.
 */

const WORKSPACE = "workspace-1";

function fakeRead(overrides: Partial<ReadService> = {}): ReadService {
  return {
    listProfiles: vi.fn(async () => []),
    dashboardSummary: vi.fn(async () => ({ currency: "USD" })),
    dashboardCountrySpend: vi.fn(async () => ({ rows: [] })),
    listCampaigns: vi.fn(async () => []),
    getCampaignDetail: vi.fn(async () => null),
    listSearchTerms: vi.fn(async () => []),
    getSearchTermDetail: vi.fn(async () => null),
    listBooks: vi.fn(async () => []),
    listRecommendations: vi.fn(async () => []),
    getRecommendation: vi.fn(async () => null),
    getCannibalizationResolutionContext: vi.fn(async () => null),
    getConversionResolutionContext: vi.fn(async () => null),
    listChangeSets: vi.fn(async () => []),
    listSyncRuns: vi.fn(async () => []),
    dataFreshness: vi.fn(async () => ({ profiles: [], fxRates: null })),
    ...overrides,
  } as unknown as ReadService;
}

async function connect(read: ReadService) {
  const server = buildMcpServer({ read, workspaceId: WORKSPACE });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0]?.text ?? "";
}

describe("MCP tool surface", () => {
  let read: ReadService;
  let client: Client;

  beforeEach(async () => {
    read = fakeRead();
    client = await connect(read);
  });

  it("exposes the read-only v1 tool set", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_campaign",
      "get_country_spend",
      "get_dashboard_summary",
      "get_recommendation",
      "get_search_term",
      "get_sync_status",
      "list_books",
      "list_campaigns",
      "list_change_sets",
      "list_profiles",
      "list_recommendations",
      "list_search_terms",
    ]);
  });

  it("scopes dashboard summary calls to the workspace and forwards filters", async () => {
    await client.callTool({
      name: "get_dashboard_summary",
      arguments: { days: 14, country: "all", currency: "EUR", books: ["b1"] },
    });
    expect(read.dashboardSummary).toHaveBeenCalledWith(
      WORKSPACE,
      14,
      "all",
      ["b1"],
      "EUR",
    );
  });

  it("returns campaign detail and an error for an unknown campaign", async () => {
    const missing = await client.callTool({
      name: "get_campaign",
      arguments: { campaignId: "nope" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("nope");

    read = fakeRead({
      getCampaignDetail: vi.fn(async () => ({ campaignId: "c1" }) as never),
    });
    client = await connect(read);
    const found = await client.callTool({
      name: "get_campaign",
      arguments: { campaignId: "c1", days: 7 },
    });
    expect(found.isError).toBeUndefined();
    expect(JSON.parse(textOf(found))).toEqual({ campaignId: "c1" });
    expect(read.getCampaignDetail).toHaveBeenCalledWith(
      WORKSPACE,
      "c1",
      7,
      undefined,
    );
  });

  it("maps recommendation filters onto the read service filter shape", async () => {
    await client.callTool({
      name: "list_recommendations",
      arguments: { type: "wasteful_search_term", state: "pending" },
    });
    expect(read.listRecommendations).toHaveBeenCalledWith(WORKSPACE, {
      type: "wasteful_search_term",
      state: "pending",
      bookIds: undefined,
    });
  });

  it("attaches cannibalization context to conflict recommendations", async () => {
    read = fakeRead({
      getRecommendation: vi.fn(
        async () =>
          ({ id: "rec-1", type: "cannibalization_conflict" }) as never,
      ),
      getCannibalizationResolutionContext: vi.fn(
        async () => ({ term: "fantasy books" }) as never,
      ),
    });
    client = await connect(read);
    const result = await client.callTool({
      name: "get_recommendation",
      arguments: { recommendationId: "rec-1" },
    });
    expect(JSON.parse(textOf(result))).toEqual({
      recommendation: { id: "rec-1", type: "cannibalization_conflict" },
      context: { term: "fantasy books" },
    });
    expect(read.getCannibalizationResolutionContext).toHaveBeenCalledWith(
      WORKSPACE,
      "rec-1",
    );
    expect(read.getConversionResolutionContext).not.toHaveBeenCalled();
  });

  it("combines sync runs and freshness in get_sync_status", async () => {
    await client.callTool({ name: "get_sync_status", arguments: {} });
    expect(read.listSyncRuns).toHaveBeenCalledWith(WORKSPACE);
    expect(read.dataFreshness).toHaveBeenCalledWith(WORKSPACE);
  });

  it("rejects invalid tool arguments before touching the service", async () => {
    const result = await client.callTool({
      name: "list_recommendations",
      arguments: { state: "bogus" },
    });
    expect(result.isError).toBe(true);
    expect(read.listRecommendations).not.toHaveBeenCalled();
  });
});
