import { describe, expect, it } from "vitest";
import {
  listProfilesInRegion,
  translateProfile,
} from "../src/adapters/profiles.js";
import { getReportStatus } from "../src/adapters/reporting.js";
import {
  listCampaigns,
  listKeywords,
  listNegativeKeywords,
  listTargets,
} from "../src/adapters/sp-campaigns.js";
import { mapWriteResults } from "../src/adapters/sp-writes.js";
import { AdapterValidationError } from "../src/errors.js";
import { TEST_CONTEXT, fixture, jsonResponse, makeHttp } from "./helpers.js";

/**
 * Contract/fixture tests (plan §14): every sanitized fixture must validate
 * against its adapter schema; unknown additive fields are tolerated; removal
 * or type change of a required field fails with a clear error.
 */

function withJunk<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, v) => v),
    (key, v) => v,
  );
}

describe("profiles fixtures", () => {
  it.each(["profiles-na.json", "profiles-eu.json", "profiles-fe.json"])(
    "validates %s against the profiles adapter",
    async (name) => {
      const region = name.includes("eu")
        ? "EU"
        : name.includes("fe")
          ? "FE"
          : "NA";
      const { http } = makeHttp({ handler: () => jsonResponse(fixture(name)) });
      const profiles = await listProfilesInRegion(
        http,
        TEST_CONTEXT.accessToken,
        region,
      );
      for (const profile of profiles) {
        expect(profile.region).toBe(region);
        expect(profile.profileId).toMatch(/^\d+$/);
        expect(profile.currencyCode).toMatch(/^[A-Z]{3}$/);
        expect(profile.accountType).toBeTruthy();
      }
    },
  );

  it("tolerates unknown additive fields", () => {
    const rows = withJunk(fixture("profiles-na.json")) as Record<
      string,
      unknown
    >[];
    rows[0].brandNewAmazonField = { nested: ["junk"] };
    const { http } = makeHttp({ handler: () => jsonResponse(rows) });
    return expect(
      listProfilesInRegion(http, TEST_CONTEXT.accessToken, "NA"),
    ).resolves.toHaveLength(2);
  });

  it("fails clearly when a required field is removed", async () => {
    const rows = withJunk(fixture("profiles-na.json")) as Record<
      string,
      unknown
    >[];
    delete rows[0].profileId;
    const { http } = makeHttp({ handler: () => jsonResponse(rows) });
    const error = await listProfilesInRegion(
      http,
      TEST_CONTEXT.accessToken,
      "NA",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterValidationError);
    expect((error as AdapterValidationError).message).toContain("profileId");
  });

  it("fails clearly when a required field changes type", async () => {
    const rows = withJunk(fixture("profiles-na.json")) as Record<
      string,
      unknown
    >[];
    (rows[0].accountInfo as Record<string, unknown>).type = 42;
    const { http } = makeHttp({ handler: () => jsonResponse(rows) });
    await expect(
      listProfilesInRegion(http, TEST_CONTEXT.accessToken, "NA"),
    ).rejects.toBeInstanceOf(AdapterValidationError);
  });
});

describe("report status fixtures", () => {
  const cases: Array<[string, string]> = [
    ["report-status-pending.json", "queued"],
    ["report-status-in-progress.json", "polling"],
    ["report-status-success.json", "downloading"],
    ["report-status-failure.json", "failed"],
  ];

  it.each(cases)("maps %s to internal state %s", async (name, state) => {
    const { http } = makeHttp({ handler: () => jsonResponse(fixture(name)) });
    const status = await getReportStatus(http, TEST_CONTEXT, "rpt-1");
    expect(status.state).toBe(state);
    if (state === "downloading") {
      expect(status.downloadUrl).toContain("s3.amazonaws.com");
    }
    if (state === "failed") {
      expect(status.failureReason).toBeTruthy();
    }
  });

  it("rejects an unknown Amazon status value", async () => {
    const payload = withJunk(fixture("report-status-pending.json")) as Record<
      string,
      unknown
    >;
    payload.status = "SOMETHING_NEW";
    const { http } = makeHttp({ handler: () => jsonResponse(payload) });
    await expect(
      getReportStatus(http, TEST_CONTEXT, "rpt-1"),
    ).rejects.toBeInstanceOf(AdapterValidationError);
  });
});

describe("SP list fixtures", () => {
  it("validates the campaigns list page and keeps raw payloads", async () => {
    const page = fixture("sp-campaigns-list.json") as Record<string, unknown>;
    delete page.nextToken; // single page for this test
    const { http } = makeHttp({ handler: () => jsonResponse(page) });
    const campaigns = await listCampaigns(http, TEST_CONTEXT);
    expect(campaigns).toHaveLength(2);
    expect(campaigns[0].campaignId).toBe("901234567");
    expect(campaigns[0].dailyBudget).toBe(10);
    expect(campaigns[0].raw).toMatchObject({ name: "Book One - Auto" });
  });

  it("validates keywords, targets, and negative keywords fixtures", async () => {
    const { http: kwHttp } = makeHttp({
      handler: () => jsonResponse(fixture("sp-keywords-list.json")),
    });
    const keywords = await listKeywords(kwHttp, TEST_CONTEXT);
    expect(keywords[0].keywordText).toBe("fantasy adventure");
    expect(keywords[1].bid).toBeNull();

    const { http: targetHttp } = makeHttp({
      handler: () => jsonResponse(fixture("sp-targets-list.json")),
    });
    const targets = await listTargets(targetHttp, TEST_CONTEXT);
    expect(targets[0].expressionType).toBe("MANUAL");

    const { http: negHttp } = makeHttp({
      handler: () => jsonResponse(fixture("sp-negativeKeywords-list.json")),
    });
    const negatives = await listNegativeKeywords(negHttp, TEST_CONTEXT);
    expect(negatives[0].matchType).toBe("NEGATIVE_EXACT");
  });

  it("tolerates additive fields on list items", async () => {
    const page = withJunk(fixture("sp-keywords-list.json")) as {
      keywords: Record<string, unknown>[];
    };
    page.keywords[0].futureField = "junk";
    const { http } = makeHttp({ handler: () => jsonResponse(page) });
    await expect(listKeywords(http, TEST_CONTEXT)).resolves.toHaveLength(2);
  });

  it("fails clearly when a list item loses a required field", async () => {
    const page = withJunk(fixture("sp-keywords-list.json")) as {
      keywords: Record<string, unknown>[];
    };
    delete page.keywords[0].keywordText;
    const { http } = makeHttp({ handler: () => jsonResponse(page) });
    await expect(listKeywords(http, TEST_CONTEXT)).rejects.toBeInstanceOf(
      AdapterValidationError,
    );
  });
});

describe("write multi-status fixtures", () => {
  it("maps mixed keyword write results per item", () => {
    const payload = fixture("sp-keywords-write-207.json") as {
      keywords: Array<Record<string, unknown>>;
    };
    const results = mapWriteResults(
      [{ actionId: "act-1" }, { actionId: "act-2" }],
      payload.keywords as never,
    );
    expect(results).toEqual([
      {
        actionId: "act-1",
        status: "applied",
        code: "SUCCESS",
        message: undefined,
        amazonEntityId: "601122334",
      },
      {
        actionId: "act-2",
        status: "failed",
        code: "INVALID_VALUE",
        message: "Bid is below the minimum allowed for this marketplace",
        amazonEntityId: undefined,
      },
    ]);
  });

  it("maps mixed negative-keyword write results per item", () => {
    const payload = fixture("sp-negativeKeywords-write-207.json") as {
      negativeKeywords: Array<Record<string, unknown>>;
    };
    const results = mapWriteResults(
      [{ actionId: "neg-1" }, { actionId: "neg-2" }],
      payload.negativeKeywords as never,
    );
    expect(results[0].status).toBe("applied");
    expect(results[0].amazonEntityId).toBe("990123457");
    expect(results[1]).toMatchObject({
      status: "failed",
      code: "DUPLICATE_VALUE",
    });
  });

  it("never treats batch success as per-item success: missing items fail explicitly", () => {
    const results = mapWriteResults(
      [{ actionId: "a" }, { actionId: "b" }],
      [{ code: "SUCCESS", index: 0 }],
    );
    expect(results[1]).toMatchObject({
      status: "failed",
      code: "MISSING_RESULT",
    });
  });
});

describe("translateProfile", () => {
  it("normalizes ids to strings and extracts account info", () => {
    // translateProfile receives schema-validated input (ids already strings).
    const profile = translateProfile(
      {
        profileId: "1111111111",
        countryCode: "US",
        currencyCode: "USD",
        timezone: "America/Los_Angeles",
        accountInfo: {
          marketplaceStringId: "ATVPDKIKX0DER",
          id: "AMZNACCTUS01",
          type: "vendor",
          name: "Author US Account",
        },
      },
      "NA",
    );
    expect(profile).toMatchObject({
      profileId: "1111111111",
      region: "NA",
      countryCode: "US",
      currencyCode: "USD",
      timezone: "America/Los_Angeles",
      accountId: "AMZNACCTUS01",
      accountType: "vendor",
      accountName: "Author US Account",
    });
  });
});
