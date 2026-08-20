import { describe, expect, it } from "vitest";
import type { AmazonProfile } from "@amazon-king/contracts";
import {
  marketplaceOptions,
  resolveCountry,
  sortMarketplacesBySpend,
  countryNameForCode,
} from "./marketplaces";

function profile(
  countryCode: string,
  currencyCode: string,
  overrides: Partial<AmazonProfile> = {},
): AmazonProfile {
  return {
    profileId: `${countryCode}-${currencyCode}`,
    accountId: null,
    region: countryCode === "US" ? "NA" : "EU",
    countryCode,
    currencyCode,
    timezone: null,
    accountType: null,
    enabled: true,
    writeEnabled: false,
    ...overrides,
  };
}

describe("marketplace country choices", () => {
  it("groups enabled profiles and puts the USA first", () => {
    const options = marketplaceOptions([
      profile("GB", "GBP"),
      profile("US", "USD"),
      profile("GB", "GBP", { profileId: "GB-second" }),
      profile("CA", "CAD", { enabled: false }),
    ]);

    expect(options.map((option) => option.countryCode)).toEqual(["US", "GB"]);
    expect(options[1]?.profileIds).toEqual(["GB-GBP", "GB-second"]);
  });

  it("names Amazon's UK marketplace code as United Kingdom", () => {
    expect(countryNameForCode("UK")).toBe("United Kingdom");
    expect(countryNameForCode("GB")).toBe("United Kingdom");
  });

  it("defaults to the USA and falls back when no US profile is enabled", () => {
    const withUs = marketplaceOptions([
      profile("GB", "GBP"),
      profile("US", "USD"),
    ]);
    const withoutUs = marketplaceOptions([profile("GB", "GBP")]);

    expect(resolveCountry(undefined, withUs)).toBe("US");
    expect(resolveCountry("GB", withUs)).toBe("GB");
    expect(resolveCountry("US", withoutUs)).toBe("GB");
  });
});

describe("sortMarketplacesBySpend", () => {
  it("orders countries by spend descending, zero-spend countries last in prior order", () => {
    const options = marketplaceOptions([
      profile("US", "USD"),
      profile("AU", "AUD"),
      profile("GB", "GBP"),
      profile("DE", "EUR"),
    ]);
    const sorted = sortMarketplacesBySpend(
      options,
      new Map([
        ["DE", 12.5],
        ["US", 30],
      ]),
    );

    // US has the most spend despite the US-first default; AU and GB have no
    // metrics and keep their previous relative order at the end.
    expect(sorted.map((option) => option.countryCode)).toEqual([
      "US",
      "DE",
      "AU",
      "GB",
    ]);
  });

  it("keeps the original order when no spend data is available", () => {
    const options = marketplaceOptions([
      profile("US", "USD"),
      profile("GB", "GBP"),
    ]);

    expect(
      sortMarketplacesBySpend(options, new Map()).map(
        (option) => option.countryCode,
      ),
    ).toEqual(["US", "GB"]);
  });
});
