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
