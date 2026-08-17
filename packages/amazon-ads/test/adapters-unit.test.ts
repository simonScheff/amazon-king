import { gzipSync } from "node:zlib";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildReportRequestBody,
  downloadReport,
  requestReport,
} from "../src/adapters/reporting.js";
import {
  listAdGroups,
  listCampaigns,
  listKeywords,
  listNegativeKeywords,
  listNegativeTargets,
  listProductAds,
  listTargets,
} from "../src/adapters/sp-campaigns.js";
import { listCampaignOptimizationRules } from "../src/adapters/sp-rules.js";
import {
  buildAdGroupBidUpdateBody,
  buildAdGroupCreateBody,
  buildCampaignBiddingUpdateBody,
  buildCampaignCreateBody,
  buildCampaignNegativeKeywordCreateBody,
  buildKeywordBidUpdateBody,
  buildKeywordCreateBody,
  buildNegativeKeywordCreateBody,
  buildNegativeTargetCreateBody,
  buildOptimizationRuleUpdateBody,
  buildProductAdCreateBody,
  buildTargetBidUpdateBody,
  buildTargetCreateBody,
  createNegativeTargets,
  createTargets,
  deleteCampaignNegativeKeywords,
  disableOptimizationRules,
  updateKeywordBids,
  updateTargetBids,
} from "../src/adapters/sp-writes.js";
import { parseReportRows } from "../src/report-schemas.js";
import { AmazonApiError } from "../src/errors.js";
import {
  TEST_CONTEXT,
  binaryResponse,
  captureLogs,
  fixture,
  jsonResponse,
  makeHttp,
  mockFetch,
} from "./helpers.js";

describe("SP list pagination", () => {
  it("follows nextToken until exhausted", async () => {
    const page1 = fixture("sp-campaigns-list.json"); // has nextToken
    const page2 = {
      campaigns: [
        {
          campaignId: 901234569,
          name: "Book Three - Auto",
          state: "ENABLED",
        },
      ],
    };
    const { http, calls } = makeHttp({
      handler: (request, n) => jsonResponse(n === 1 ? page1 : page2),
    });
    const campaigns = await listCampaigns(http, TEST_CONTEXT);
    expect(campaigns).toHaveLength(3);
    expect(campaigns[2].campaignId).toBe("901234569");
    expect(calls).toHaveLength(2);
    const body2 = JSON.parse(calls[1].body as string) as Record<
      string,
      unknown
    >;
    expect(body2.nextToken).toBe("page-2-token");
    expect(calls[0].url).toBe(
      "https://advertising-api.amazon.com/sp/campaigns/list",
    );
  });

  it.each([
    [
      "campaigns",
      listCampaigns,
      "campaigns",
      "application/vnd.spcampaign.v3+json",
    ],
    [
      "ad groups",
      listAdGroups,
      "adGroups",
      "application/vnd.spadGroup.v3+json",
    ],
    [
      "product ads",
      listProductAds,
      "productAds",
      "application/vnd.spproductAd.v3+json",
    ],
    ["keywords", listKeywords, "keywords", "application/vnd.spkeyword.v3+json"],
    [
      "targets",
      listTargets,
      "targetingClauses",
      "application/vnd.sptargetingClause.v3+json",
    ],
    [
      "negative keywords",
      listNegativeKeywords,
      "negativeKeywords",
      "application/vnd.spnegativeKeyword.v3+json",
    ],
    [
      "negative targets",
      listNegativeTargets,
      "negativeTargetingClauses",
      "application/vnd.spNegativeTargetingClause.v3+json",
    ],
  ] as const)(
    "sends the required SP v3 media type for %s",
    async (_name, list, responseKey, mediaType) => {
      const { http, calls } = makeHttp({
        handler: (request) =>
          jsonResponse(
            request.url.endsWith("/sp/campaignNegativeKeywords/list")
              ? { campaignNegativeKeywords: [] }
              : request.url.endsWith("/sp/campaignNegativeTargets/list")
                ? { campaignNegativeTargetingClauses: [] }
                : { [responseKey]: [] },
          ),
      });

      await list(http, TEST_CONTEXT);

      expect(calls[0].headers.accept).toBe(mediaType);
      expect(calls[0].headers["content-type"]).toBe(mediaType);
    },
  );
});

describe("SP optimization rules", () => {
  it("uses exact campaign and BID category filters when discovering CPC-changing rules", async () => {
    const { http, calls } = makeHttp({
      handler: () =>
        jsonResponse({
          code: "SUCCESS",
          nextToken: null,
          optimizationRules: [
            {
              optimizationRuleId: "rule-1",
              ruleName: "Weekend boost",
              ruleCategory: "BID",
              ruleSubCategory: "SCHEDULE",
              status: "ENABLED",
            },
          ],
        }),
    });

    const rules = await listCampaignOptimizationRules(
      http,
      TEST_CONTEXT,
      "campaign-1",
    );
    expect(rules[0]?.name).toBe("Weekend boost");
    expect(JSON.parse(calls[0]!.body as string)).toMatchObject({
      campaignFilter: {
        campaignId: { filterType: "EXACT_MATCH", values: ["campaign-1"] },
      },
      optimizationRuleFilter: {
        ruleCategory: { filterType: "EXACT_MATCH", values: ["BID"] },
      },
    });
  });

  it("maps the optimization-rule multi-status response by input order", async () => {
    const { http } = makeHttp({
      handler: () =>
        jsonResponse({
          code: "SUCCESS",
          responses: [
            {
              code: "SUCCESS",
              details: "",
              optimizationRule: { optimizationRuleId: "rule-1" },
            },
          ],
        }),
    });
    await expect(
      disableOptimizationRules(http, TEST_CONTEXT, [
        {
          actionId: "action-1",
          kind: "update_optimization_rule",
          optimizationRuleId: "rule-1",
          rule: { ruleName: "Weekend boost", status: "DISABLED" },
        },
      ]),
    ).resolves.toEqual([
      {
        actionId: "action-1",
        status: "applied",
        code: "SUCCESS",
        message: "",
        amazonEntityId: "rule-1",
      },
    ]);
  });
});

describe("reporting v3 request bodies", () => {
  it("builds a Reporting v3 create body from an internal ReportSpec", () => {
    const body = buildReportRequestBody({
      reportType: "spSearchTerm",
      startDate: "2024-05-01",
      endDate: "2024-05-31",
      metrics: ["impressions", "clicks", "cost", "purchases7d", "sales7d"],
    }) as { configuration: Record<string, unknown> };
    expect(body.configuration).toMatchObject({
      adProduct: "SPONSORED_PRODUCTS",
      groupBy: ["searchTerm"],
      reportTypeId: "spSearchTerm",
      timeUnit: "DAILY",
      format: "GZIP_JSON",
    });
    const columns = body.configuration.columns as string[];
    expect(columns).toContain("date");
    expect(columns).toContain("searchTerm");
    expect(columns).toContain("keywordId");
    expect(columns).toContain("purchases7d");
  });

  it("uses the current advertised-product grouping and targeting columns", () => {
    const advertised = buildReportRequestBody({
      reportType: "spAdvertisedProduct",
      startDate: "2024-05-01",
      endDate: "2024-05-31",
      metrics: ["clicks"],
    }) as { configuration: { groupBy: string[]; columns: string[] } };
    expect(advertised.configuration.groupBy).toEqual(["advertiser"]);
    expect(advertised.configuration.columns).toContain("date");

    const targeting = buildReportRequestBody({
      reportType: "spTargeting",
      startDate: "2024-05-01",
      endDate: "2024-05-31",
      metrics: ["clicks"],
    }) as { configuration: { columns: string[] } };
    expect(targeting.configuration.columns).toContain("keywordId");
    expect(targeting.configuration.columns).not.toContain("targetingId");
    expect(targeting.configuration.columns).not.toContain("targetingText");
  });

  it("rejects an invalid spec before any HTTP call", () => {
    expect(() =>
      buildReportRequestBody({
        reportType: "spSearchTerm",
        startDate: "01/05/2024",
        endDate: "2024-05-31",
        metrics: ["clicks"],
      }),
    ).toThrow();
  });

  it("returns a job handle, never report data", async () => {
    const { http } = makeHttp({
      handler: () => jsonResponse(fixture("report-create.json")),
    });
    const job = await requestReport(http, TEST_CONTEXT, {
      reportType: "spCampaigns",
      startDate: "2024-05-01",
      endDate: "2024-05-31",
      metrics: ["clicks"],
    });
    expect(job).toMatchObject({
      reportId: "rpt-0f3e1a2b-0001",
      profileId: TEST_CONTEXT.profileId,
      reportType: "spCampaigns",
      state: "queued",
    });
  });
});

describe("report download", () => {
  function collectingSink(): { sink: Writable; content: () => string } {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    return { sink, content: () => Buffer.concat(chunks).toString("utf8") };
  }

  it("streams and gunzips into the sink without buffering in memory", async () => {
    const rows = fixture("report-rows-spCampaigns.json");
    const gzipped = gzipSync(Buffer.from(JSON.stringify(rows)));
    const logs = captureLogs();
    const { fetch, calls } = mockFetch(() => binaryResponse(gzipped));
    const { sink, content } = collectingSink();
    const url =
      "https://offline-report-storage-prod.s3.amazonaws.com/x/report.gz?X-Amz-Signature=secret-sig";

    const result = await downloadReport(url, sink, {
      fetch,
      logger: logs.logger,
    });

    expect(calls).toHaveLength(1);
    const parsed = parseReportRows("spCampaigns", JSON.parse(content()));
    expect(parsed).toHaveLength(2);
    expect(result.bytesWritten).toBe(content().length);
    // The pre-signed URL (and its signature) must never reach the logs.
    expect(logs.text()).not.toContain("X-Amz-Signature");
    expect(logs.text()).not.toContain(url);
  });

  it("supports uncompressed payloads", async () => {
    const rows = fixture("report-rows-spCampaigns.json");
    const { fetch } = mockFetch(() =>
      binaryResponse(Buffer.from(JSON.stringify(rows))),
    );
    const { sink, content } = collectingSink();
    await downloadReport("https://x/report.json", sink, {
      fetch,
      logger: captureLogs().logger,
      compressed: false,
    });
    expect(JSON.parse(content())).toHaveLength(2);
  });

  it("fails cleanly when the download errors", async () => {
    const { fetch } = mockFetch(() =>
      binaryResponse(new Uint8Array(), { status: 403 }),
    );
    const { sink } = collectingSink();
    await expect(
      downloadReport("https://x/expired", sink, {
        fetch,
        logger: captureLogs().logger,
      }),
    ).rejects.toBeInstanceOf(AmazonApiError);
  });
});

describe("SP create request bodies", () => {
  it("builds the SP v3 campaign create body with Amazon state enums", () => {
    expect(
      buildCampaignCreateBody([
        {
          actionId: "c1",
          kind: "create_campaign",
          name: "Book One - Auto",
          dailyBudget: "5.00",
          targetingType: "AUTO",
          startDate: "2024-06-01",
          state: "paused",
        },
      ]),
    ).toEqual({
      campaigns: [
        {
          name: "Book One - Auto",
          targetingType: "AUTO",
          state: "PAUSED",
          budget: { budget: 5, budgetType: "DAILY" },
          startDate: "2024-06-01",
        },
      ],
    });
  });

  it("builds the SP v3 ad group create body from resolved parent ids", () => {
    expect(
      buildAdGroupCreateBody([
        {
          actionId: "g1",
          kind: "create_ad_group",
          campaignActionId: "c1",
          name: "Book One - Ad Group",
          defaultBid: "0.45",
          resolvedCampaignId: "4567890123",
        },
      ]),
    ).toEqual({
      adGroups: [
        {
          campaignId: "4567890123",
          name: "Book One - Ad Group",
          state: "ENABLED",
          defaultBid: 0.45,
        },
      ],
    });
  });

  it("builds the SP v3 product ad create body with campaign and ad group ids", () => {
    expect(
      buildProductAdCreateBody([
        {
          actionId: "p1",
          kind: "create_product_ad",
          adGroupActionId: "g1",
          asin: "B0CXYZ1234",
          state: "enabled",
          resolvedCampaignId: "4567890123",
          resolvedAdGroupId: "3456789012",
        },
      ]),
    ).toEqual({
      productAds: [
        {
          campaignId: "4567890123",
          adGroupId: "3456789012",
          asin: "B0CXYZ1234",
          state: "ENABLED",
        },
      ],
    });
  });

  it("builds the SP v3 keyword create body with match type and bid", () => {
    expect(
      buildKeywordCreateBody([
        {
          actionId: "k1",
          kind: "create_keyword",
          adGroupActionId: "g1",
          keywordText: "dragon fantasy book",
          matchType: "EXACT",
          bid: "0.60",
          state: "paused",
          resolvedCampaignId: "4567890123",
          resolvedAdGroupId: "3456789012",
        },
      ]),
    ).toEqual({
      keywords: [
        {
          campaignId: "4567890123",
          adGroupId: "3456789012",
          keywordText: "dragon fantasy book",
          matchType: "EXACT",
          bid: 0.6,
          state: "PAUSED",
        },
      ],
    });
  });

  it("builds the SP v3 target create body with an ASIN_SAME_AS expression", () => {
    expect(
      buildTargetCreateBody([
        {
          actionId: "t1",
          kind: "create_target",
          adGroupActionId: "g1",
          expressionAsin: "B0CXYZ1234",
          bid: "0.50",
          state: "enabled",
          resolvedCampaignId: "4567890123",
          resolvedAdGroupId: "3456789012",
        },
        {
          actionId: "t2",
          kind: "create_target",
          adGroupActionId: "g1",
          expressionAsin: "B0ASIN0001",
          state: "paused",
          resolvedCampaignId: "4567890123",
          resolvedAdGroupId: "3456789012",
        },
      ]),
    ).toEqual({
      targetingClauses: [
        {
          campaignId: "4567890123",
          adGroupId: "3456789012",
          expressionType: "MANUAL",
          expression: [{ type: "ASIN_SAME_AS", value: "B0CXYZ1234" }],
          bid: 0.5,
          state: "ENABLED",
        },
        {
          campaignId: "4567890123",
          adGroupId: "3456789012",
          expressionType: "MANUAL",
          expression: [{ type: "ASIN_SAME_AS", value: "B0ASIN0001" }],
          // No bid: the target inherits the ad group default bid.
          state: "PAUSED",
        },
      ],
    });
  });

  it("builds the SP v3 negative-target create body at campaign level", () => {
    expect(
      buildNegativeTargetCreateBody([
        {
          actionId: "nt1",
          kind: "add_negative_target",
          campaignId: "901234567",
          expressionAsin: "B0COMPET01",
        },
      ]),
    ).toEqual({
      campaignNegativeTargetingClauses: [
        {
          campaignId: "901234567",
          expression: [{ type: "ASIN_SAME_AS", value: "B0COMPET01" }],
          state: "ENABLED",
        },
      ],
    });
  });
});

describe("SP write request bodies", () => {
  it("updates keyword bids without changing their enabled or paused state", () => {
    const body = buildKeywordBidUpdateBody([
      {
        actionId: "a1",
        kind: "update_bid",
        keywordId: "601122334",
        bid: "0.55",
        state: "PAUSED",
      },
    ]) as { keywords: Array<Record<string, unknown>> };
    expect(body.keywords).toEqual([
      { keywordId: "601122334", bid: 0.55, state: "PAUSED" },
    ]);
  });

  it("translates every Max CPC layer without re-enabling paused entities", () => {
    expect(
      buildTargetBidUpdateBody([
        {
          actionId: "t1",
          kind: "update_bid",
          entityType: "target",
          keywordId: "88",
          bid: "0.70",
          state: "PAUSED",
        },
      ]),
    ).toEqual({
      targetingClauses: [{ targetId: "88", bid: 0.7, state: "PAUSED" }],
    });
    expect(
      buildAdGroupBidUpdateBody([
        {
          actionId: "g1",
          kind: "update_ad_group_default_bid",
          adGroupId: "77",
          bid: "0.70",
          state: "PAUSED",
        },
      ]),
    ).toEqual({
      adGroups: [{ adGroupId: "77", defaultBid: 0.7, state: "PAUSED" }],
    });
    expect(
      buildCampaignBiddingUpdateBody([
        {
          actionId: "c1",
          kind: "update_campaign_bidding",
          campaignId: "66",
          state: "ENABLED",
          dynamicBidding: {
            strategy: "LEGACY_FOR_SALES",
            placements: [],
            audiences: [],
          },
        },
      ]),
    ).toEqual({
      campaigns: [
        {
          campaignId: "66",
          state: "ENABLED",
          dynamicBidding: {
            strategy: "LEGACY_FOR_SALES",
          },
        },
      ],
    });
    expect(
      buildOptimizationRuleUpdateBody([
        {
          actionId: "r1",
          kind: "update_optimization_rule",
          optimizationRuleId: "55",
          rule: { name: "Weekend boost", status: "ENABLED" },
        },
      ]),
    ).toEqual({
      optimizationRules: [
        {
          optimizationRuleId: "55",
          name: "Weekend boost",
          status: "DISABLED",
        },
      ],
    });
  });

  it("translates add_negative_exact actions into a POST body", () => {
    const body = buildNegativeKeywordCreateBody([
      {
        actionId: "n1",
        kind: "add_negative_exact",
        campaignId: "901234567",
        adGroupId: "705432109",
        keywordText: "free books",
      },
      {
        actionId: "n2",
        kind: "add_negative_exact",
        campaignId: "901234567",
        keywordText: "pdf download",
      },
    ]) as { negativeKeywords: Array<Record<string, unknown>> };
    expect(body.negativeKeywords[0]).toEqual({
      campaignId: "901234567",
      adGroupId: "705432109",
      keywordText: "free books",
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    });
    // Campaign-level negative: no adGroupId key.
    expect(body.negativeKeywords[1]).not.toHaveProperty("adGroupId");
  });

  it("uses the campaign-negative v3 body for campaign-level routing", () => {
    expect(
      buildCampaignNegativeKeywordCreateBody([
        {
          actionId: "n1",
          kind: "add_negative_exact",
          campaignId: "901234567",
          keywordText: "tractor colouring book",
        },
      ]),
    ).toEqual({
      campaignNegativeKeywords: [
        {
          campaignId: "901234567",
          keywordText: "tractor colouring book",
          matchType: "NEGATIVE_EXACT",
          state: "ENABLED",
        },
      ],
    });
  });

  it("deletes campaign negatives with the v3 id filter", async () => {
    const { http, calls } = makeHttp({
      handler: () =>
        jsonResponse(fixture("sp-campaignNegativeKeywords-write-207.json"), {
          status: 207,
        }),
    });
    const results = await deleteCampaignNegativeKeywords(http, TEST_CONTEXT, [
      {
        actionId: "r1",
        kind: "remove_negative_exact",
        negativeKeywordId: "990123459",
        scope: "campaign",
      },
    ]);
    expect(calls[0].url).toContain("/sp/campaignNegativeKeywords/delete");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      campaignNegativeKeywordIdFilter: { include: ["990123459"] },
    });
    expect(results[0]).toMatchObject({
      actionId: "r1",
      status: "applied",
      amazonEntityId: "990123459",
    });
  });

  it("applies per-item 207 results end to end", async () => {
    const { http, calls } = makeHttp({
      handler: () =>
        jsonResponse(fixture("sp-keywords-write-207.json"), { status: 207 }),
    });
    const results = await updateKeywordBids(http, TEST_CONTEXT, [
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
    ]);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/sp/keywords");
    expect(results.map((r) => r.status)).toEqual(["applied", "failed"]);
  });

  it("sends a paused automatic target as a bid-only state-preserving update", async () => {
    const { http, calls } = makeHttp({
      handler: () =>
        jsonResponse(
          {
            targetingClauses: {
              success: [{ targetId: 519095653042278 }],
              error: [],
            },
          },
          { status: 207 },
        ),
    });

    const results = await updateTargetBids(http, TEST_CONTEXT, [
      {
        actionId: "target-1",
        kind: "update_bid",
        entityType: "target",
        keywordId: "519095653042278",
        bid: "0.65",
        state: "PAUSED",
      },
    ]);

    expect(JSON.parse(calls[0].body as string)).toEqual({
      targetingClauses: [
        { targetId: "519095653042278", bid: 0.65, state: "PAUSED" },
      ],
    });
    expect(results[0]?.status).toBe("applied");
  });
});

describe("SP target and negative-target reads", () => {
  it("parses target expressions, preferring resolvedExpression", async () => {
    const { http } = makeHttp({
      handler: () => jsonResponse(fixture("sp-targets-list.json")),
    });
    const targets = await listTargets(http, TEST_CONTEXT);
    expect(targets[0].expression).toEqual([
      { type: "ASIN_SAME_AS", value: "B0ASIN0001" },
    ]);

    // resolvedExpression wins when both forms are present and differ.
    const page = fixture("sp-targets-list.json") as {
      targetingClauses: Array<Record<string, unknown>>;
    };
    page.targetingClauses[0].resolvedExpression = [
      { type: "ASIN_SAME_AS", value: "B0RESOLVED1" },
    ];
    const { http: resolvedHttp } = makeHttp({
      handler: () => jsonResponse(page),
    });
    const resolvedTargets = await listTargets(resolvedHttp, TEST_CONTEXT);
    expect(resolvedTargets[0].expression).toEqual([
      { type: "ASIN_SAME_AS", value: "B0RESOLVED1" },
    ]);
  });

  it("accepts auto-targeting clauses whose expressions carry no value", async () => {
    // SP v3 only requires `type` on an expression predicate; auto targets
    // (close/loose match, substitutes, complements) have no value.
    const { http } = makeHttp({
      handler: () =>
        jsonResponse({
          targetingClauses: [
            {
              targetId: 880123457,
              campaignId: 901234568,
              adGroupId: 705432110,
              state: "ENABLED",
              bid: 0.4,
              expressionType: "AUTO",
              expression: [{ type: "QUERY_HIGH_REL_MATCHES" }],
              resolvedExpression: [{ type: "QUERY_HIGH_REL_MATCHES" }],
            },
          ],
        }),
    });
    const targets = await listTargets(http, TEST_CONTEXT);
    expect(targets).toHaveLength(1);
    expect(targets[0].expression).toEqual([{ type: "QUERY_HIGH_REL_MATCHES" }]);
  });

  it("parses campaign-level negative targets with their ASIN expression", async () => {
    const { http, calls } = makeHttp({
      handler: (request) =>
        request.url.endsWith("/sp/campaignNegativeTargets/list")
          ? jsonResponse({ campaignNegativeTargetingClauses: [] })
          : jsonResponse(fixture("sp-negativeTargets-list.json")),
    });
    const negativeTargets = await listNegativeTargets(http, TEST_CONTEXT);
    expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
      "/sp/campaignNegativeTargets/list",
      "/sp/negativeTargets/list",
    ]);
    expect(negativeTargets).toHaveLength(1);
    expect(negativeTargets[0]).toMatchObject({
      negativeTargetId: "770123456",
      campaignId: "901234567",
      state: "ENABLED",
      expression: [{ type: "ASIN_SAME_AS", value: "B0COMPET01" }],
    });
  });

  it("parses campaign negative targeting clauses from the campaign-level endpoint", async () => {
    const { http } = makeHttp({
      handler: (request) =>
        request.url.endsWith("/sp/campaignNegativeTargets/list")
          ? jsonResponse({
              campaignNegativeTargetingClauses: [
                {
                  campaignNegativeTargetingClauseId: 770123999,
                  campaignId: 901234567,
                  state: "ENABLED",
                  resolvedExpression: [
                    { type: "ASIN_SAME_AS", value: "B0COMPET02" },
                  ],
                },
              ],
            })
          : jsonResponse({ negativeTargetingClauses: [] }),
    });
    const negativeTargets = await listNegativeTargets(http, TEST_CONTEXT);
    expect(negativeTargets).toHaveLength(1);
    expect(negativeTargets[0]).toMatchObject({
      negativeTargetId: "770123999",
      campaignId: "901234567",
      expression: [{ type: "ASIN_SAME_AS", value: "B0COMPET02" }],
    });
  });

  it("treats a profile without negative targets as an empty list", async () => {
    const { http } = makeHttp({
      handler: (request) =>
        request.url.endsWith("/sp/campaignNegativeTargets/list")
          ? jsonResponse({ campaignNegativeTargetingClauses: [] })
          : jsonResponse({ negativeTargetingClauses: [] }),
    });
    await expect(listNegativeTargets(http, TEST_CONTEXT)).resolves.toEqual([]);
  });
});

describe("SP target writes", () => {
  it("creates targets and maps the per-item 207 results", async () => {
    const { http, calls } = makeHttp({
      handler: () =>
        jsonResponse(fixture("sp-targets-create-207.json"), { status: 207 }),
    });
    const results = await createTargets(http, TEST_CONTEXT, [
      {
        actionId: "t1",
        kind: "create_target",
        adGroupActionId: "g1",
        expressionAsin: "B0CXYZ1234",
        bid: "0.50",
        state: "enabled",
        resolvedCampaignId: "4567890123",
        resolvedAdGroupId: "3456789012",
      },
      {
        actionId: "t2",
        kind: "create_target",
        adGroupActionId: "g1",
        expressionAsin: "B0BADASIN1",
        state: "enabled",
        resolvedCampaignId: "4567890123",
        resolvedAdGroupId: "3456789012",
      },
    ]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/sp/targets");
    expect(results).toEqual([
      {
        actionId: "t1",
        status: "applied",
        code: "SUCCESS",
        message: undefined,
        amazonEntityId: "880123457",
      },
      {
        actionId: "t2",
        status: "failed",
        code: "INVALID_VALUE",
        message: "The expression ASIN is not targetable in this marketplace",
        amazonEntityId: undefined,
      },
    ]);
  });

  it("creates campaign-level negative targets and extracts negativeTargetId", async () => {
    const { http, calls } = makeHttp({
      handler: () =>
        jsonResponse(fixture("sp-campaignNegativeTargets-create-207.json"), {
          status: 207,
        }),
    });
    const results = await createNegativeTargets(http, TEST_CONTEXT, [
      {
        actionId: "nt1",
        kind: "add_negative_target",
        campaignId: "901234567",
        expressionAsin: "B0COMPET01",
      },
    ]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/sp/campaignNegativeTargets");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      campaignNegativeTargetingClauses: [
        {
          campaignId: "901234567",
          expression: [{ type: "ASIN_SAME_AS", value: "B0COMPET01" }],
          state: "ENABLED",
        },
      ],
    });
    expect(results[0]).toMatchObject({
      actionId: "nt1",
      status: "applied",
      amazonEntityId: "770123456",
    });
  });
});
