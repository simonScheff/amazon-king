import { useEffect, useRef, useState } from "react";
import type { MarketplaceOption } from "../lib/marketplaces";
import { Flag } from "./flag";

/**
 * Country picker with flag images. A native <select> cannot render images
 * inside its dropdown, so this is a button + listbox instead — that is the
 * only way to show real flags in the options on every platform.
 */
export function CountrySelect({
  value,
  options,
  disabled = false,
  onChange,
  allLabel,
  allMarketsLabel,
  allMarketsDisabled = false,
  allMarketsDisabledReason,
  "aria-label": ariaLabel = "Country",
}: {
  value: string;
  options: readonly MarketplaceOption[];
  disabled?: boolean;
  onChange: (countryCode: string) => void;
  /**
   * When set, prepends an option with an empty value (no flag) that clears
   * the country selection — used when a filter covers every market.
   */
  allLabel?: string;
  /**
   * When set, prepends an "All markets" peer option whose value is the
   * `all` literal (`?country=all`) — the FX-converted all-market view
   * (docs/fx-rates-all-market-plan.md, decision 6). No flag: there is no
   * country to draw. Distinct from `allLabel`, which clears a filter.
   */
  allMarketsLabel?: string;
  /** Disables the all-markets option (e.g. FX rates not synced yet). */
  allMarketsDisabled?: boolean;
  /** Tooltip explaining why the all-markets option is disabled. */
  allMarketsDisabledReason?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.countryCode === value);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = selected
    ? selected.countryName
    : value === "" && allLabel
      ? allLabel
      : value === "all" && allMarketsLabel
        ? allMarketsLabel
        : value === "US"
          ? "United States"
          : value;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:bg-zinc-900 disabled:text-zinc-500"
      >
        <Flag countryCode={selected?.countryCode ?? value} />
        <span>{label}</span>
        <span aria-hidden="true" className="text-zinc-500">
          ▾
        </span>
      </button>
      {open && (options.length > 0 || allLabel || allMarketsLabel) ? (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll("button"),
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "ArrowDown"
                ? (index + 1) % items.length
                : (index - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
          className="absolute right-0 z-10 mt-1 min-w-full overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 py-1 shadow-lg shadow-black/40"
        >
          {allLabel ? (
            <li role="option" aria-selected={value === ""}>
              <button
                type="button"
                autoFocus={value === ""}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none"
              >
                <span>{allLabel}</span>
              </button>
            </li>
          ) : null}
          {allMarketsLabel ? (
            <li role="option" aria-selected={value === "all"}>
              <button
                type="button"
                autoFocus={value === "all"}
                disabled={allMarketsDisabled}
                title={
                  allMarketsDisabled ? allMarketsDisabledReason : undefined
                }
                onClick={() => {
                  onChange("all");
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent"
              >
                <span>{allMarketsLabel}</span>
                <span className="text-xs text-zinc-500">(one currency)</span>
              </button>
            </li>
          ) : null}
          {options.map((option) => (
            <li
              key={option.countryCode}
              role="option"
              aria-selected={option.countryCode === value}
            >
              <button
                type="button"
                autoFocus={option.countryCode === value}
                onClick={() => {
                  onChange(option.countryCode);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none"
              >
                <Flag countryCode={option.countryCode} />
                <span>{option.countryName}</span>
                <span className="text-xs text-zinc-500">
                  ({option.currencyCodes.join(", ")})
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
