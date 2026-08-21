import { useMemo } from "react";
import { useUpdateWorkspaceSettings } from "../api/endpoints";
import { displayCurrencyOptions } from "../lib/marketplaces";
import type { MarketplaceOption } from "../lib/marketplaces";
import { Select } from "./ui/input";
import { useToast } from "./toast";

/**
 * Workspace display-currency picker (docs/fx-rates-all-market-plan.md,
 * decision 5). Shown on the overview while "All markets" is active and on
 * the Settings page. PATCHes the workspace setting; the mutation invalidates
 * the dashboard queries, which then re-fetch converted figures in the new
 * currency. Options are the currencies present among enabled profiles plus
 * USD/EUR/GBP.
 */
export function DisplayCurrencySelect({
  value,
  options,
  "aria-label": ariaLabel = "Display currency",
}: {
  /** Current display currency (from the summary response or settings cache). */
  value: string;
  options: readonly MarketplaceOption[];
  "aria-label"?: string;
}) {
  const update = useUpdateWorkspaceSettings();
  const toast = useToast();
  const currencies = useMemo(() => displayCurrencyOptions(options), [options]);
  // Keep the current value selectable even when no enabled profile uses it.
  const choices = currencies.includes(value)
    ? currencies
    : [value, ...currencies];

  return (
    <div className="relative">
      <Select
        aria-label={ariaLabel}
        value={value}
        disabled={update.isPending}
        className="appearance-none pr-8"
        onChange={(event) => {
          // Read the value now: the mutation callback runs after React has
          // recycled the event.
          const displayCurrency = event.currentTarget.value;
          update.mutate(
            { displayCurrency },
            {
              onError: (error) =>
                toast(`Currency update failed: ${error.message}`, "error"),
            },
          );
        }}
      >
        {choices.map((currency) => (
          <option key={currency} value={currency}>
            {currency}
          </option>
        ))}
      </Select>
      {/* Same ▾ indicator as CountrySelect — a native <select> draws its own
          arrow unless appearance-none is set. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-500"
      >
        ▾
      </span>
    </div>
  );
}
