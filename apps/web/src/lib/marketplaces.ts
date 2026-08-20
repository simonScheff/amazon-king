import type { AmazonProfile } from "@amazon-king/contracts";

export interface MarketplaceOption {
  countryCode: string;
  countryName: string;
  currencyCodes: string[];
  profileIds: string[];
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Amazon profile data can say UK; Intl.DisplayNames follows ISO 3166-1 (GB). */
const countryCodeAliases: Readonly<Record<string, string>> = {
  UK: "GB",
};

export function countryNameForCode(countryCode: string): string {
  const iso =
    countryCodeAliases[countryCode.toUpperCase()] ?? countryCode.toUpperCase();
  return regionNames.of(iso) ?? countryCode;
}

/** Group enabled Amazon profiles into country choices for dashboard filtering. */
export function marketplaceOptions(
  profiles: readonly AmazonProfile[],
): MarketplaceOption[] {
  const byCountry = new Map<
    string,
    { currencyCodes: Set<string>; profileIds: string[] }
  >();

  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const existing = byCountry.get(profile.countryCode) ?? {
      currencyCodes: new Set<string>(),
      profileIds: [],
    };
    existing.currencyCodes.add(profile.currencyCode);
    existing.profileIds.push(profile.profileId);
    byCountry.set(profile.countryCode, existing);
  }

  return [...byCountry.entries()]
    .map(([countryCode, value]) => ({
      countryCode,
      countryName: countryNameForCode(countryCode),
      currencyCodes: [...value.currencyCodes].sort(),
      profileIds: value.profileIds,
    }))
    .sort((a, b) => {
      if (a.countryCode === "US") return -1;
      if (b.countryCode === "US") return 1;
      return a.countryName.localeCompare(b.countryName);
    });
}

/** Prefer a valid URL choice, then the USA, then the first enabled country. */
export function resolveCountry(
  requestedCountry: string | undefined,
  options: readonly MarketplaceOption[],
): string {
  if (options.some((option) => option.countryCode === requestedCountry)) {
    return requestedCountry!;
  }
  if (options.some((option) => option.countryCode === "US")) return "US";
  return options[0]?.countryCode ?? "US";
}

/**
 * Order country choices by ad spend descending. Sort is stable: countries
 * without metrics in the window (missing from the map, treated as zero) keep
 * their existing relative order at the end.
 */
export function sortMarketplacesBySpend(
  options: readonly MarketplaceOption[],
  spendByCountry: ReadonlyMap<string, number>,
): MarketplaceOption[] {
  return [...options].sort(
    (a, b) =>
      (spendByCountry.get(b.countryCode) ?? 0) -
      (spendByCountry.get(a.countryCode) ?? 0),
  );
}
