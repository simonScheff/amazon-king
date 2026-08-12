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
  listProductAds,
  listTargets,
} from "../src/adapters/sp-campaigns.js";
import {
  buildKeywordBidUpdateBody,
  buildNegativeKeywordCreateBody,
  updateKeywordBids,
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
  ] as const)(
    "sends the required SP v3 media type for %s",
    async (_name, list, responseKey, mediaType) => {
      const { http, calls } = makeHttp({
        handler: () => jsonResponse({ [responseKey]: [] }),
      });

      await list(http, TEST_CONTEXT);

      expect(calls[0].headers.accept).toBe(mediaType);
      expect(calls[0].headers["content-type"]).toBe(mediaType);
    },
  );
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

describe("SP write request bodies", () => {
  it("translates update_bid actions into a PUT /sp/keywords body", () => {
    const body = buildKeywordBidUpdateBody([
      {
        actionId: "a1",
        kind: "update_bid",
        keywordId: "601122334",
        bid: "0.55",
      },
    ]) as { keywords: Array<Record<string, unknown>> };
    expect(body.keywords).toEqual([
      { keywordId: 601122334, bid: 0.55, state: "ENABLED" },
    ]);
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
      campaignId: 901234567,
      adGroupId: 705432109,
      keywordText: "free books",
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    });
    // Campaign-level negative: no adGroupId key.
    expect(body.negativeKeywords[1]).not.toHaveProperty("adGroupId");
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
});
