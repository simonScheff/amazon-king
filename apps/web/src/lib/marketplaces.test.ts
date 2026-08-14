import { describe, expect, it } from "vitest";
import type { AmazonProfile } from "@amazon-king/contracts";
import { marketplaceOptions, resolveCountry } from "./marketplaces";

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
