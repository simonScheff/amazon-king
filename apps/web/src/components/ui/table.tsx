import type {
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

/**
 * `stickyHeader` pins the header row while the rows scroll. A sticky element
 * sticks to its nearest scroll container, and the horizontal-overflow wrapper
 * below is already one, so the wrapper has to own the vertical scrolling too —
 * page scrolling alone can never pin the header. The bottom rule is an inset
 * shadow because collapsed table borders scroll away from a sticky cell, and
 * the header stays below the `z-10` overlay layer that dropdowns use so it
 * cannot paint over an open menu.
 */
export function Table({
  className = "",
  stickyHeader = false,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { stickyHeader?: boolean }) {
  return (
    <div
      className={`w-full max-w-full overflow-x-auto ${
        stickyHeader
          ? "max-h-[calc(100dvh-4rem)] overflow-y-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1] [&_thead_th]:shadow-[inset_0_-1px_0_var(--color-zinc-800)]"
          : ""
      }`}
    >
      <table
        className={`w-full text-left text-sm text-zinc-300 ${className}`}
        {...props}
      />
    </div>
  );
}

export function Th({
  className = "",
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={`border-b border-zinc-800 bg-zinc-850 px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 ${className}`}
      {...props}
    />
  );
}

export function Td({
  className = "",
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={`border-b border-zinc-800/60 px-4 py-3 align-top ${className}`}
      {...props}
    />
  );
}
