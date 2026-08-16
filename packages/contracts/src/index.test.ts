import { describe, expect, it } from "vitest";
import {
  bookSchema,
  bookMappingInputSchema,
  campaignDetailSchema,
  cannibalizationResolutionContextSchema,
  campaignListRowSchema,
  campaignMaxCpcSchema,
  recommendationChangeActionType,
  recommendationSchema,
  sessionInfoSchema,
  setCampaignMaxCpcSchema,
} from "./index.js";

describe("contracts smoke test", () => {
  it("identifies executable and review-only recommendation types", () => {
    expect(recommendationChangeActionType.expensive_target).toBe("update_bid");
    expect(recommendationChangeActionType.wasteful_search_term).toBe(
      "add_negative_exact",
    );
    expect(recommendationChangeActionType.cannibalization_conflict).toBeNull();
  });

  it("validates the fact-only context for a cannibalization decision", () => {
    const context = cannibalizationResolutionContextSchema.parse({
      recommendationId: "rec-1",
      profileId: "profile-1",
      searchTerm: "tractor colouring book",
      currency: "GBP",
      confidence: 0.5,
      evidenceWindow: { start: "2026-07-15", end: "2026-08-13" },
      dataFreshness: "2026-08-13T10:00:00Z",
      expiresAt: "2026-08-20T10:00:00Z",
      totalSpend: "21.98",
      campaigns: [
        {
          campaignId: "amazon-campaign-1",
          name: "Book - Exact",
          state: "ENABLED",
          targetingType: "MANUAL",
          spend: "15.25",
          orders: 4,
        },
        {
          campaignId: "amazon-campaign-2",
          name: "Book - Discovery",
          state: "ENABLED",
          targetingType: "AUTO",
          spend: "6.73",
          orders: 1,
        },
      ],
    });
    expect(context.campaigns).toHaveLength(2);
    expect(context.totalSpend).toBe("21.98");
  });

  it("round-trips a SessionInfo payload", () => {
    const payload = {
      userId: "usr_1",
      workspaceId: "wsp_1",
      email: "owner@example.com",
      expiresAt: "2026-08-06T20:00:00Z",
      csrfToken: "csrf-token-123",
    };
    const parsed = sessionInfoSchema.parse(payload);
    expect(sessionInfoSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it("accepts a valid Recommendation with string-encoded decimals", () => {
    const parsed = recommendationSchema.parse({
      id: "rec_1",
      type: "wasteful_search_term",
      state: "pending",
      priority: 2,
      profileId: "prf_1",
      campaignId: "cmp_1",
      adGroupId: null,
      targetId: null,
      searchTerm: "dragon coloring book",
      currentValue: "0.45",
      proposedValue: null,
      rationale: "34 clicks, $15.30 spend, zero orders in the evidence window.",
      confidence: 0.82,
      evidenceWindow: { start: "2026-07-01", end: "2026-07-31" },
      dataFreshness: "2026-08-05T00:00:00Z",
      ruleVersion: "wasteful_search_term.v1",
      expiresAt: "2026-08-12T00:00:00Z",
      createdAt: "2026-08-05T12:00:00Z",
    });
    expect(parsed.currentValue).toBe("0.45");
  });

  it("rejects a float-style money payload with too many decimals", () => {
    expect(() =>
      sessionInfoSchema.parse({
        userId: "u",
        workspaceId: "w",
        email: "not-an-email",
        expiresAt: "x",
        csrfToken: "c",
      }),
    ).toThrow();
  });

  it("normalizes a book mapping and deduplicates selected profiles", () => {
    expect(
      bookMappingInputSchema.parse({
        profileIds: ["profile-us", "profile-us", "profile-ca"],
        asin: " B012345678 ",
        title: "  My Coloring Book  ",
        format: "paperback",
      }),
    ).toEqual({
      profileIds: ["profile-us", "profile-ca"],
      asin: "B012345678",
      title: "My Coloring Book",
      format: "paperback",
    });
  });

  it("accepts saved marketplace economics on a book", () => {
    const book = bookSchema.parse({
      id: "book-1",
      asin: "B012345678",
      title: "My Coloring Book",
      format: "paperback",
      status: "active",
      profileIds: ["profile-ca"],
      marketplaceAsins: [{ profileId: "profile-ca", asin: "B012345678" }],
      economics: [
        {
          profileId: "profile-ca",
          effectiveFrom: "2026-08-13",
          currency: "CAD",
          listPrice: "14.2100",
          estimatedRoyaltyPerSale: "5.0000",
          targetAcos: null,
          goalMode: "balanced",
          maxSpendWithoutSale: null,
          maxBid: null,
          maxDailyBudget: null,
          notes: null,
        },
      ],
    });
    expect(book.economics[0]?.currency).toBe("CAD");
  });

  it("accepts campaign profitability over a selected daily window", () => {
    const detail = campaignDetailSchema.parse({
      dateRange: { start: "2026-08-07", end: "2026-08-13" },
      currency: "USD",
      campaign: {
        profileId: "profile-us",
        campaignId: "campaign-1",
        name: "General",
        state: "enabled",
        amazonConsoleUrl:
          "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
        totals: {
          impressions: 100,
          clicks: 10,
          cost: "8.0000",
          sales: "20.0000",
          orders: 2,
          acos: 0.4,
          estimatedRoyalty: "10.0000",
          estimatedAdProfit: "2.0000",
        },
      },
      economicsMissing: false,
      dataCurrentThrough: "2026-08-13T00:00:00.000Z",
      daily: [
        {
          date: "2026-08-13",
          cost: "8.0000",
          sales: "20.0000",
          estimatedRoyalty: "10.0000",
          estimatedAdProfit: "2.0000",
        },
      ],
      adGroups: [],
      targets: [],
      searchTerms: [],
      negativeKeywords: [
        {
          id: "negative-1",
          keywordText: "free books",
          matchType: "NEGATIVE_EXACT",
          level: "campaign",
          adGroupId: null,
          adGroupName: null,
          state: "ENABLED",
        },
      ],
    });

    expect(detail.campaign.totals.estimatedAdProfit).toBe("2.0000");
    expect(detail.negativeKeywords[0]?.keywordText).toBe("free books");
  });

  it("accepts a campaign-list row with windowed profitability", () => {
    const row = campaignListRowSchema.parse({
      profileId: "profile-us",
      campaignId: "campaign-1",
      name: "General",
      state: "enabled",
      amazonConsoleUrl:
        "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
      totals: {
        impressions: 100,
        clicks: 10,
        cost: "8.0000",
        sales: "20.0000",
        orders: 2,
      },
      profitability: {
        dateRange: { start: "2026-08-07", end: "2026-08-13" },
        currency: "USD",
        estimatedRoyalty: "10.0000",
        estimatedAdProfit: "2.0000",
        economicsMissing: false,
        dataCurrentThrough: "2026-08-13",
      },
    });

    expect(row.profitability.estimatedAdProfit).toBe("2.0000");
  });

  it("validates a campaign-wide CPC ceiling and its coverage state", () => {
    expect(setCampaignMaxCpcSchema.parse({ maxCpc: "0.75" })).toEqual({
      maxCpc: "0.75",
    });
    expect(() => setCampaignMaxCpcSchema.parse({ maxCpc: "0" })).toThrow();
    const controls = campaignMaxCpcSchema.parse({
      campaignId: "campaign-1",
      profileId: "profile-us",
      currency: "USD",
      maxCpc: "0.75",
      status: "covered",
      strategy: "LEGACY_FOR_SALES",
      adjustments: [],
      activeBidRules: [],
      coverageIssues: [],
      currentMaxBaseBid: "0.75",
      currentMaxAdjustedBid: "0.75",
      counts: { adGroups: 2, explicitTargetBids: 8, bidsAboveCeiling: 0 },
      writeEnabled: true,
      sourceReadAt: "2026-08-13T08:00:00.000Z",
      enforcedAt: "2026-08-13T08:00:00.000Z",
    });
    expect(controls.status).toBe("covered");
  });
});
