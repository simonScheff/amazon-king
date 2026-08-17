import { describe, expect, it } from "vitest";
import {
  campaignCreationCreateSchema,
  campaignCreationTargetSchema,
} from "./index.js";

const baseInput = {
  profileIds: ["profile-us"],
  campaign: {
    name: "Book - Exact",
    dailyBudget: "5.00",
    targetingType: "MANUAL",
    startDate: "2026-08-14",
  },
  adGroup: { name: "Ad group 1", defaultBid: "0.45" },
  bookId: "book-1",
} as const;

const keyword = {
  text: "dragon coloring book",
  matchType: "EXACT",
  bid: "0.45",
} as const;

const target = { asin: "B0CRHVCT1T", bid: "0.40" } as const;

describe("campaignCreationCreateSchema", () => {
  it("accepts a keywords-only payload and leaves targets unset", () => {
    const parsed = campaignCreationCreateSchema.parse({
      ...baseInput,
      keywords: [keyword],
    });
    expect(parsed.keywords).toHaveLength(1);
    expect(parsed.targets).toBeUndefined();
    expect(parsed.campaign.state).toBe("paused");
  });

  it("accepts a targets-only payload and defaults keywords to []", () => {
    const parsed = campaignCreationCreateSchema.parse({
      ...baseInput,
      targets: [target],
    });
    expect(parsed.keywords).toEqual([]);
    expect(parsed.targets ?? []).toHaveLength(1);
  });

  it("accepts a payload with both keywords and targets", () => {
    const parsed = campaignCreationCreateSchema.parse({
      ...baseInput,
      keywords: [keyword],
      targets: [{ asin: "b0crhvct1t" }],
    });
    expect(parsed.targets?.[0]?.bid).toBeUndefined();
  });

  it("rejects a payload with neither keywords nor targets", () => {
    expect(campaignCreationCreateSchema.safeParse(baseInput).success).toBe(
      false,
    );
    expect(
      campaignCreationCreateSchema.safeParse({
        ...baseInput,
        keywords: [],
        targets: [],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty keywords array without targets", () => {
    expect(
      campaignCreationCreateSchema.safeParse({ ...baseInput, keywords: [] })
        .success,
    ).toBe(false);
  });

  it("accepts an AUTO campaign with no keywords or targets", () => {
    const parsed = campaignCreationCreateSchema.parse({
      ...baseInput,
      campaign: { ...baseInput.campaign, targetingType: "AUTO" },
    });
    expect(parsed.keywords).toEqual([]);
    expect(parsed.targets).toBeUndefined();
  });

  it("rejects keywords or product targets on an AUTO campaign", () => {
    const autoInput = {
      ...baseInput,
      campaign: { ...baseInput.campaign, targetingType: "AUTO" },
    } as const;
    // Amazon: "Only negative keywords and negative product targets are
    // allowed in auto-targeting campaigns".
    expect(
      campaignCreationCreateSchema.safeParse({
        ...autoInput,
        keywords: [keyword],
      }).success,
    ).toBe(false);
    expect(
      campaignCreationCreateSchema.safeParse({
        ...autoInput,
        targets: [target],
      }).success,
    ).toBe(false);
  });
});

describe("campaignCreationTargetSchema", () => {
  it("accepts an ASIN with an optional bid", () => {
    expect(campaignCreationTargetSchema.parse(target)).toEqual(target);
    expect(campaignCreationTargetSchema.parse({ asin: "B0CRHVCT1T" })).toEqual({
      asin: "B0CRHVCT1T",
    });
  });

  it("rejects non-ASIN values and invalid bids", () => {
    expect(
      campaignCreationTargetSchema.safeParse({ asin: "coloring book" }).success,
    ).toBe(false);
    expect(
      campaignCreationTargetSchema.safeParse({ asin: "B01234567" }).success,
    ).toBe(false);
    expect(
      campaignCreationTargetSchema.safeParse({
        asin: "B0CRHVCT1T",
        bid: "-0.40",
      }).success,
    ).toBe(false);
    expect(
      campaignCreationTargetSchema.safeParse({
        asin: "B0CRHVCT1T",
        bid: "0.12345",
      }).success,
    ).toBe(false);
  });
});
