import type { AmazonProfile } from "@amazon-king/contracts";

export interface MarketplaceOption {
  countryCode: string;
  countryName: string;
  currencyCodes: string[];
  profileIds: string[];
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryNameForCode(countryCode: string): string {
  return regionNames.of(countryCode) ?? countryCode;
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
