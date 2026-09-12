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
    listNegatives: vi.fn(async () => []),
    getNegativeDetail: vi.fn(async () => null),
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
      "get_negative",
      "get_recommendation",
      "get_search_term",
      "get_sync_status",
      "list_books",
      "list_campaigns",
      "list_change_sets",
      "list_negatives",
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

  it("forwards list_negatives and get_negative filters", async () => {
    await client.callTool({
      name: "list_negatives",
      arguments: { days: 14, books: ["b1"], country: "DE", kind: "keyword" },
    });
    expect(read.listNegatives).toHaveBeenCalledWith(
      WORKSPACE,
      14,
      ["b1"],
      "DE",
      "keyword",
    );

    const missing = await client.callTool({
      name: "get_negative",
      arguments: { kind: "product", value: "nope" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("nope");

    read = fakeRead({
      getNegativeDetail: vi.fn(async () => ({ value: "B0CATALOG1" }) as never),
    });
    client = await connect(read);
    const found = await client.callTool({
      name: "get_negative",
      arguments: { kind: "product", value: "B0CATALOG1", days: 7 },
    });
    expect(found.isError).toBeUndefined();
    expect(JSON.parse(textOf(found))).toEqual({ value: "B0CATALOG1" });
    expect(read.getNegativeDetail).toHaveBeenCalledWith(
      WORKSPACE,
      "product",
      "B0CATALOG1",
      7,
      undefined,
      undefined,
    );
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

  it("exposes and executes write tools when write service is configured", async () => {
    const fakeWrite = {
      createRecommendationChangeSet: vi.fn(async () => ({
        changeSetId: "cs-1",
      })),
      createCampaignNegativesChangeSet: vi.fn(async () => ({
        changeSetId: "cs-2",
      })),
      createSearchTermExclusion: vi.fn(async () => ({ exclusionAdded: true })),
      setCampaignMaxCpc: vi.fn(async () => ({ maxCpc: "0.36" })),
      updateCampaignState: vi.fn(async () => ({ state: "PAUSED" })),
      addKeywordsToCampaign: vi.fn(async () => ({ changeSetId: "cs-kw" })),
      setCampaignPlacementMultiplier: vi.fn(async () => ({
        changeSetId: "cs-pm",
      })),
      rejectRecommendation: vi.fn(async () => ({ rejected: true })),
    };

    const server = buildMcpServer({
      read,
      write: fakeWrite,
      workspaceId: WORKSPACE,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const writeClient = new Client({
      name: "write-test-client",
      version: "0.0.0",
    });
    await Promise.all([
      server.connect(serverTransport),
      writeClient.connect(clientTransport),
    ]);

    const { tools } = await writeClient.listTools();
    expect(tools.map((t) => t.name)).toContain(
      "create_recommendation_change_set",
    );
    expect(tools.map((t) => t.name)).toContain("add_campaign_negatives");
    expect(tools.map((t) => t.name)).toContain("create_search_term_exclusion");
    expect(tools.map((t) => t.name)).toContain("set_campaign_max_cpc");
    expect(tools.map((t) => t.name)).toContain("update_campaign_state");
    expect(tools.map((t) => t.name)).toContain("add_keywords_to_campaign");
    expect(tools.map((t) => t.name)).toContain(
      "set_campaign_placement_multiplier",
    );
    expect(tools.map((t) => t.name)).toContain("reject_recommendation");

    await writeClient.callTool({
      name: "add_keywords_to_campaign",
      arguments: {
        campaignId: "camp-1",
        keywords: [
          {
            keywordText: "dog coloring book",
            matchType: "PHRASE",
            bid: "0.38",
          },
        ],
      },
    });
    expect(fakeWrite.addKeywordsToCampaign).toHaveBeenCalledWith(
      WORKSPACE,
      "camp-1",
      [{ keywordText: "dog coloring book", matchType: "PHRASE", bid: "0.38" }],
      undefined,
    );

    await writeClient.callTool({
      name: "add_campaign_negatives",
      arguments: { campaignId: "camp-1", searchTerms: ["dog coloring book"] },
    });
    expect(fakeWrite.createCampaignNegativesChangeSet).toHaveBeenCalledWith(
      WORKSPACE,
      "camp-1",
      ["dog coloring book"],
    );

    await writeClient.callTool({
      name: "set_campaign_max_cpc",
      arguments: { campaignId: "camp-1", maxCpc: "0.36" },
    });
    expect(fakeWrite.setCampaignMaxCpc).toHaveBeenCalledWith(
      WORKSPACE,
      "camp-1",
      "0.36",
    );

    await writeClient.callTool({
      name: "set_campaign_placement_multiplier",
      arguments: {
        campaignId: "camp-1",
        topOfSearchPercentage: 30,
        productPagePercentage: 10,
      },
    });
    expect(fakeWrite.setCampaignPlacementMultiplier).toHaveBeenCalledWith(
      WORKSPACE,
      "camp-1",
      {
        topOfSearchPercentage: 30,
        productPagePercentage: 10,
        restOfSearchPercentage: undefined,
      },
    );
  });

  it("rejects invalid write tool arguments before touching the service", async () => {
    const fakeWrite = {
      createRecommendationChangeSet: vi.fn(),
      createCampaignNegativesChangeSet: vi.fn(),
      createSearchTermExclusion: vi.fn(),
      setCampaignMaxCpc: vi.fn(),
      updateCampaignState: vi.fn(),
      addKeywordsToCampaign: vi.fn(),
      setCampaignPlacementMultiplier: vi.fn(),
      rejectRecommendation: vi.fn(),
    };

    const server = buildMcpServer({
      read,
      write: fakeWrite,
      workspaceId: WORKSPACE,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const writeClient = new Client({
      name: "validation-client",
      version: "0.0.0",
    });
    await Promise.all([
      server.connect(serverTransport),
      writeClient.connect(clientTransport),
    ]);

    // Invalid max CPC decimal
    const badCpc = await writeClient.callTool({
      name: "set_campaign_max_cpc",
      arguments: { campaignId: "camp-1", maxCpc: "-0.50" },
    });
    expect(badCpc.isError).toBe(true);

    // Empty search term exclusion
    const emptyTerm = await writeClient.callTool({
      name: "create_search_term_exclusion",
      arguments: { searchTerm: "   " },
    });
    expect(emptyTerm.isError).toBe(true);

    // No percentage in placement multiplier
    const noMultiplier = await writeClient.callTool({
      name: "set_campaign_placement_multiplier",
      arguments: { campaignId: "camp-1" },
    });
    expect(noMultiplier.isError).toBe(true);

    // Percentage > 900
    const excessiveMultiplier = await writeClient.callTool({
      name: "set_campaign_placement_multiplier",
      arguments: { campaignId: "camp-1", topOfSearchPercentage: 1000 },
    });
    expect(excessiveMultiplier.isError).toBe(true);
  });

  it("supports dynamic async workspaceId getter function", async () => {
    let currentWorkspace = "workspace-dynamic-1";
    const server = buildMcpServer({
      read,
      workspaceId: async () => currentWorkspace,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const dynamicClient = new Client({
      name: "dynamic-test-client",
      version: "0.0.0",
    });
    await Promise.all([
      server.connect(serverTransport),
      dynamicClient.connect(clientTransport),
    ]);

    await dynamicClient.callTool({
      name: "list_profiles",
      arguments: {},
    });
    expect(read.listProfiles).toHaveBeenCalledWith("workspace-dynamic-1");

    currentWorkspace = "workspace-dynamic-2";
    await dynamicClient.callTool({
      name: "list_profiles",
      arguments: {},
    });
    expect(read.listProfiles).toHaveBeenCalledWith("workspace-dynamic-2");
  });
});
