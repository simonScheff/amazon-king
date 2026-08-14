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
  "aria-label": ariaLabel = "Country",
}: {
  value: string;
  options: readonly MarketplaceOption[];
  disabled?: boolean;
  onChange: (countryCode: string) => void;
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
      {open && options.length > 0 ? (
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
