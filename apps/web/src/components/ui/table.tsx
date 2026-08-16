import type {
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

export function Table({
  className = "",
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full max-w-full overflow-x-auto">
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
