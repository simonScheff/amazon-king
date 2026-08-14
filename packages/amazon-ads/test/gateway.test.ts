import { describe, expect, it, vi } from "vitest";
import {
  createAmazonAdsGateway,
  type ProfileDirectoryEntry,
} from "../src/gateway.js";
import { captureLogs, fixture, jsonResponse, mockFetch } from "./helpers.js";
import { createAdsHttpClient } from "../src/http.js";

const PROFILE_ENTRY: ProfileDirectoryEntry = {
  profileId: "1111111111",
  connectionId: "conn-1",
  region: "NA",
  accountId: "AMZNACCTUS01",
};

function makeGateway(handler: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(handler);
  const logs = captureLogs();
  const http = createAdsHttpClient({
    clientId: "lwa-test-client-id",
    fetch,
    logger: logs.logger,
    sleep: () => Promise.resolve(),
  });
  const getAccessToken = vi.fn(async () => "Atza|cached-token");
  const gateway = createAmazonAdsGateway({
    clientId: "lwa-test-client-id",
    tokenManager: { getAccessToken },
    profileDirectory: { get: async () => PROFILE_ENTRY },
    http,
    logger: logs.logger,
    now: () => "2024-06-01T00:00:00.000Z",
  });
  return { gateway, calls, logs, getAccessToken };
}

describe("gateway.listProfiles", () => {
  it("discovers profiles across all three regional hosts", async () => {
    const fixturesByRegion: Record<string, unknown> = {
      "https://advertising-api.amazon.com/v2/profiles":
        fixture("profiles-na.json"),
      "https://advertising-api-eu.amazon.com/v2/profiles":
        fixture("profiles-eu.json"),
      "https://advertising-api-fe.amazon.com/v2/profiles":
        fixture("profiles-fe.json"),
    };
    const { gateway, calls, getAccessToken } = makeGateway((request) =>
      jsonResponse(fixturesByRegion[request.url] ?? []),
    );
    const profiles = await gateway.listProfiles("conn-1");
    expect(getAccessToken).toHaveBeenCalledWith("conn-1");
    expect(calls).toHaveLength(3);
    expect(profiles).toHaveLength(3);
    expect(profiles.map((p) => p.region)).toEqual(["NA", "NA", "EU"]);
    expect(profiles[0]).toMatchObject({
      profileId: "1111111111",
      countryCode: "US",
      currencyCode: "USD",
      accountType: "vendor",
    });
  });
});

describe("gateway.syncCampaignStructure", () => {
  it("assembles a StructureSnapshot from the SP list adapters", async () => {
    const pages: Record<string, unknown> = {
      "/sp/campaigns/list": fixture("sp-campaigns-list.json"),
      "/sp/adGroups/list": fixture("sp-adGroups-list.json"),
      "/sp/productAds/list": fixture("sp-productAds-list.json"),
      "/sp/keywords/list": fixture("sp-keywords-list.json"),
      "/sp/targets/list": fixture("sp-targets-list.json"),
      "/sp/negativeKeywords/list": fixture("sp-negativeKeywords-list.json"),
      "/sp/campaignNegativeKeywords/list": fixture(
        "sp-campaignNegativeKeywords-list.json",
      ),
    };
    const { gateway } = makeGateway((request) => {
      const path = new URL(request.url).pathname;
      const page = pages[path] as Record<string, unknown> | undefined;
      // Strip pagination so each list call resolves in one page.
      if (page && "nextToken" in page) {
        const { nextToken, ...rest } = page;
        return jsonResponse(rest);
      }
      return jsonResponse(page ?? {});
    });
    const snapshot = await gateway.syncCampaignStructure("1111111111");
    expect(snapshot.profileId).toBe("1111111111");
    expect(snapshot.retrievedAt).toBe("2024-06-01T00:00:00.000Z");
    expect(snapshot.campaigns).toHaveLength(2);
    expect(snapshot.adGroups).toHaveLength(1);
    expect(snapshot.ads[0].asin).toBe("B0CXYZ1234");
    expect(snapshot.keywords).toHaveLength(2);
    expect(snapshot.targets).toHaveLength(1);
    expect(snapshot.negativeKeywords).toHaveLength(2);
  });
});

describe("gateway report flow", () => {
  it("requests a report then polls its status by reportId", async () => {
    const { gateway, calls } = makeGateway((request) => {
      if (request.url.endsWith("/reporting/reports")) {
        return jsonResponse(fixture("report-create.json"));
      }
      return jsonResponse(fixture("report-status-success.json"));
    });
    const job = await gateway.requestReport("1111111111", {
      reportType: "spCampaigns",
      startDate: "2024-05-01",
      endDate: "2024-05-31",
      metrics: ["impressions", "clicks", "cost"],
    });
    expect(job.reportId).toBe("rpt-0f3e1a2b-0001");

    const status = await gateway.getReport("rpt-0f3e1a2b-0001");
    expect(status.state).toBe("downloading");
    expect(status.downloadUrl).toBeTruthy();
    expect(calls[1].url).toContain("/reporting/reports/rpt-0f3e1a2b-0001");
  });

  it("fails clearly for an unknown reportId", async () => {
    const { gateway } = makeGateway(() => jsonResponse({}));
    await expect(gateway.getReport("rpt-unknown")).rejects.toThrow(
      /Unknown reportId/,
    );
  });
});

describe("gateway.previewCapabilities", () => {
  it("reports SP-only capabilities for the MVP boundary", async () => {
    const { gateway } = makeGateway(() => jsonResponse({}));
    const caps = await gateway.previewCapabilities("1111111111");
    expect(caps).toEqual({
      profileId: "1111111111",
      region: "NA",
      adProducts: ["SPONSORED_PRODUCTS"],
      reportTypes: [
        "spCampaigns",
        "spSearchTerm",
        "spTargeting",
        "spAdvertisedProduct",
      ],
      writeOperations: [
        "create_campaign",
        "create_ad_group",
        "create_product_ad",
        "create_keyword",
        "update_bid",
        "update_ad_group_default_bid",
        "update_campaign_bidding",
        "update_optimization_rule",
        "add_negative_exact",
        "remove_negative_exact",
      ],
    });
  });
});

describe("gateway.applyActions", () => {
  it("routes actions to the write adapters and merges per-item results", async () => {
    const { gateway, calls } = makeGateway((request) => {
      if (request.url.endsWith("/sp/keywords")) {
        return jsonResponse(fixture("sp-keywords-write-207.json"), {
          status: 207,
        });
      }
      if (request.url.endsWith("/sp/campaignNegativeKeywords")) {
        return jsonResponse(
          fixture("sp-campaignNegativeKeywords-write-207.json"),
          {
            status: 207,
          },
        );
      }
      if (request.url.endsWith("/sp/negativeKeywords")) {
        return jsonResponse(fixture("sp-negativeKeywords-write-207.json"), {
          status: 207,
        });
      }
      throw new Error(`unexpected call: ${request.url}`);
    });
    const results = await gateway.applyActions({
      changeSetId: "cs-1",
      profileId: "1111111111",
      actions: [
        {
          actionId: "a1",
          kind: "update_bid",
          keywordId: "601122334",
          bid: "0.55",
        },
        {
          actionId: "a2",
          kind: "update_bid",
          keywordId: "601122335",
          bid: "0.02",
        },
        {
          actionId: "n1",
          kind: "add_negative_exact",
          campaignId: "901234567",
          keywordText: "free books",
        },
        {
          actionId: "n2",
          kind: "add_negative_exact",
          campaignId: "901234567",
          keywordText: "torrent",
        },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(4);
    expect(results.map((r) => [r.actionId, r.status])).toEqual([
      ["a1", "applied"],
      ["a2", "failed"],
      ["n1", "applied"],
      ["n2", "failed"],
    ]);
    // Batch HTTP success never implies per-item success.
    expect(results[1].code).toBe("INVALID_VALUE");
  });

  it("routes campaign negative rollback to the matching delete resource", async () => {
    const { gateway, calls } = makeGateway((request) => {
      if (request.url.endsWith("/sp/campaignNegativeKeywords/delete")) {
        return jsonResponse(
          {
            campaignNegativeKeywords: {
              success: [{ index: 0, campaignNegativeKeywordId: "990123459" }],
              error: [],
            },
          },
          { status: 207 },
        );
      }
      throw new Error(`unexpected call: ${request.url}`);
    });
    const results = await gateway.applyActions({
      changeSetId: "rollback-1",
      profileId: "1111111111",
      actions: [
        {
          actionId: "remove-1",
          kind: "remove_negative_exact",
          negativeKeywordId: "990123459",
          scope: "campaign",
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body as string)).toEqual({
      campaignNegativeKeywordIdFilter: { include: ["990123459"] },
    });
    expect(results[0]).toMatchObject({
      actionId: "remove-1",
      status: "applied",
    });
  });
});

describe("gateway.applyActions entity creation", () => {
  function createHandler(): Parameters<typeof makeGateway>[0] {
    return (request) => {
      if (request.url.endsWith("/sp/campaigns")) {
        return jsonResponse(fixture("sp-campaigns-create-207.json"), {
          status: 207,
        });
      }
      if (request.url.endsWith("/sp/adGroups")) {
        return jsonResponse(fixture("sp-adGroups-create-207.json"), {
          status: 207,
        });
      }
      if (request.url.endsWith("/sp/productAds")) {
        return jsonResponse(fixture("sp-productAds-create-207.json"), {
          status: 207,
        });
      }
      if (request.url.endsWith("/sp/keywords")) {
        return jsonResponse(fixture("sp-keywords-create-207.json"), {
          status: 207,
        });
      }
      throw new Error(`unexpected call: ${request.url}`);
    };
  }

  it("chains campaign → ad group → product ad + keyword with id substitution", async () => {
    const { gateway, calls } = makeGateway(createHandler());
    const results = await gateway.applyActions({
      changeSetId: "cs-create-1",
      profileId: "1111111111",
      actions: [
        {
          actionId: "c1",
          kind: "create_campaign",
          name: "Book One - Auto",
          dailyBudget: "5.00",
          targetingType: "AUTO",
          startDate: "2024-06-01",
          state: "enabled",
        },
        {
          actionId: "g1",
          kind: "create_ad_group",
          campaignActionId: "c1",
          name: "Book One - Ad Group",
          defaultBid: "0.45",
        },
        {
          actionId: "p1",
          kind: "create_product_ad",
          adGroupActionId: "g1",
          asin: "B0CXYZ1234",
          state: "enabled",
        },
        {
          actionId: "k1",
          kind: "create_keyword",
          adGroupActionId: "g1",
          keywordText: "dragon fantasy book",
          matchType: "EXACT",
          bid: "0.60",
          state: "enabled",
        },
      ],
    });
    // One call per creation phase, in dependency order.
    expect(
      calls.map((call) => [call.method, new URL(call.url).pathname]),
    ).toEqual([
      ["POST", "/sp/campaigns"],
      ["POST", "/sp/adGroups"],
      ["POST", "/sp/productAds"],
      ["POST", "/sp/keywords"],
    ]);
    // The ad group references the Amazon campaign id from phase 1.
    expect(JSON.parse(calls[1].body as string)).toEqual({
      adGroups: [
        {
          campaignId: "4567890123",
          name: "Book One - Ad Group",
          state: "ENABLED",
          defaultBid: 0.45,
        },
      ],
    });
    // Product ad and keyword reference the resolved ad group id plus the
    // campaign id derived from the ad group's parent.
    expect(JSON.parse(calls[2].body as string)).toEqual({
      productAds: [
        {
          campaignId: "4567890123",
          adGroupId: "3456789012",
          asin: "B0CXYZ1234",
          state: "ENABLED",
        },
      ],
    });
    expect(JSON.parse(calls[3].body as string)).toEqual({
      keywords: [
        {
          campaignId: "4567890123",
          adGroupId: "3456789012",
          keywordText: "dragon fantasy book",
          matchType: "EXACT",
          bid: 0.6,
          state: "ENABLED",
        },
      ],
    });
    expect(
      results.map((r) => [r.actionId, r.status, r.amazonEntityId]),
    ).toEqual([
      ["c1", "applied", "4567890123"],
      ["g1", "applied", "3456789012"],
      ["p1", "applied", "512345678901234"],
      ["k1", "applied", "601122340"],
    ]);
  });

  it("runs creation phases before update groups in a mixed change set", async () => {
    const { gateway, calls } = makeGateway((request) => {
      if (request.url.endsWith("/sp/campaigns")) {
        return jsonResponse(fixture("sp-campaigns-create-207.json"), {
          status: 207,
        });
      }
      if (request.url.endsWith("/sp/keywords")) {
        return jsonResponse(fixture("sp-keywords-write-207.json"), {
          status: 207,
        });
      }
      throw new Error(`unexpected call: ${request.url}`);
    });
    const results = await gateway.applyActions({
      changeSetId: "cs-mixed-1",
      profileId: "1111111111",
      actions: [
        {
          actionId: "a1",
          kind: "update_bid",
          keywordId: "601122334",
          bid: "0.55",
        },
        {
          actionId: "c1",
          kind: "create_campaign",
          name: "Book One - Manual",
          dailyBudget: "3.00",
          targetingType: "MANUAL",
          startDate: "2024-06-01",
          state: "paused",
        },
      ],
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT"]);
    expect(new URL(calls[0].url).pathname).toBe("/sp/campaigns");
    expect(new URL(calls[1].url).pathname).toBe("/sp/keywords");
    expect(results.map((r) => [r.actionId, r.status])).toEqual([
      ["c1", "applied"],
      ["a1", "applied"],
    ]);
  });

  it("fails dependents with PARENT_FAILED without sending them when the parent fails", async () => {
    const { gateway, calls } = makeGateway((request) => {
      if (request.url.endsWith("/sp/campaigns")) {
        return jsonResponse(fixture("sp-campaigns-create-failed-207.json"), {
          status: 207,
        });
      }
      throw new Error(`unexpected call: ${request.url}`);
    });
    const results = await gateway.applyActions({
      changeSetId: "cs-create-failed",
      profileId: "1111111111",
      actions: [
        {
          actionId: "c1",
          kind: "create_campaign",
          name: "Book One - Auto",
          dailyBudget: "0.01",
          targetingType: "AUTO",
          startDate: "2024-06-01",
          state: "enabled",
        },
        {
          actionId: "g1",
          kind: "create_ad_group",
          campaignActionId: "c1",
          name: "Book One - Ad Group",
          defaultBid: "0.45",
        },
        {
          actionId: "k1",
          kind: "create_keyword",
          adGroupActionId: "g1",
          keywordText: "dragon fantasy book",
          matchType: "EXACT",
          bid: "0.60",
          state: "enabled",
        },
      ],
    });
    // Only the campaign create call was made; dependents were never sent.
    expect(calls).toHaveLength(1);
    expect(results.map((r) => [r.actionId, r.status, r.code])).toEqual([
      ["c1", "failed", "INVALID_VALUE"],
      ["g1", "failed", "PARENT_FAILED"],
      ["k1", "failed", "PARENT_FAILED"],
    ]);
  });

  it("fails children whose parent actionId is unknown without sending them", async () => {
    const { gateway, calls } = makeGateway(() => {
      throw new Error("no Amazon calls expected");
    });
    const results = await gateway.applyActions({
      changeSetId: "cs-orphan",
      profileId: "1111111111",
      actions: [
        {
          actionId: "g1",
          kind: "create_ad_group",
          campaignActionId: "c-missing",
          name: "Orphan Ad Group",
          defaultBid: "0.45",
        },
        {
          actionId: "p1",
          kind: "create_product_ad",
          adGroupActionId: "g1",
          asin: "B0CXYZ1234",
          state: "enabled",
        },
      ],
    });
    expect(calls).toHaveLength(0);
    expect(results.map((r) => [r.actionId, r.code])).toEqual([
      ["g1", "PARENT_FAILED"],
      ["p1", "PARENT_FAILED"],
    ]);
  });

  it("maps per-item 207 partial failures on keyword creation", async () => {
    const { gateway, calls } = makeGateway(createHandler());
    const results = await gateway.applyActions({
      changeSetId: "cs-create-partial",
      profileId: "1111111111",
      actions: [
        {
          actionId: "c1",
          kind: "create_campaign",
          name: "Book One - Manual",
          dailyBudget: "5.00",
          targetingType: "MANUAL",
          startDate: "2024-06-01",
          state: "enabled",
        },
        {
          actionId: "g1",
          kind: "create_ad_group",
          campaignActionId: "c1",
          name: "Book One - Ad Group",
          defaultBid: "0.45",
        },
        {
          actionId: "k1",
          kind: "create_keyword",
          adGroupActionId: "g1",
          keywordText: "dragon fantasy book",
          matchType: "EXACT",
          bid: "0.60",
          state: "enabled",
        },
        {
          actionId: "k2",
          kind: "create_keyword",
          adGroupActionId: "g1",
          keywordText: "bad@@@keyword",
          matchType: "BROAD",
          bid: "0.40",
          state: "enabled",
        },
      ],
    });
    expect(calls).toHaveLength(3);
    const keywordResults = results.filter((r) => r.actionId.startsWith("k"));
    expect(keywordResults.map((r) => [r.actionId, r.status, r.code])).toEqual([
      ["k1", "applied", "SUCCESS"],
      ["k2", "failed", "INVALID_VALUE"],
    ]);
    expect(keywordResults[1].message).toContain("unsupported characters");
  });
});
