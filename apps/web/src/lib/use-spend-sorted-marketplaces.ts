import { useCountrySpend, useProfiles } from "../api/endpoints";
import {
  marketplaceOptions,
  sortMarketplacesBySpend,
  type MarketplaceOption,
} from "./marketplaces";

/**
 * Enabled marketplace countries ordered by ad spend over the given window
 * (descending; countries without metrics in the window keep their default
 * US-first/alphabetical order at the end). Backs every country selector so
 * all of them rank markets the same way.
 */
export function useSpendSortedMarketplaces(days: number): MarketplaceOption[] {
  const profiles = useProfiles();
  const countrySpend = useCountrySpend(days);
  return sortMarketplacesBySpend(
    marketplaceOptions(profiles.data ?? []),
    new Map(
      (countrySpend.data?.countries ?? []).map((entry) => [
        entry.countryCode,
        Number(entry.spend),
      ]),
    ),
  );
}
