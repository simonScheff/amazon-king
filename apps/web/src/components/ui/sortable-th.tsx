import type { Sort } from "../../lib/sorting";
import { Th } from "./table";

export function columnAriaSort<K extends string>(
  sort: Sort<K>,
  columns: readonly K[],
): "ascending" | "descending" | "none" {
  if (!columns.includes(sort.key)) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

export function SortButton<K extends string>({
  label,
  column,
  sort,
  onSort,
  className = "",
  title,
}: {
  label: string;
  column: K;
  sort: Sort<K>;
  onSort: (column: K) => void;
  className?: string;
  title?: string;
}) {
  const active = sort.key === column;
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      title={title}
      className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-zinc-300 ${className}`}
    >
      {label}
      <span aria-hidden="true" className="w-3">
        {active ? (sort.direction === "asc" ? "↑" : "↓") : ""}
      </span>
    </button>
  );
}

/** Column header button that drives table sorting (aria-sort + arrow). */
export function SortableTh<K extends string>({
  label,
  column,
  sort,
  onSort,
  className = "",
  title,
}: {
  label: string;
  column: K;
  sort: Sort<K>;
  onSort: (column: K) => void;
  className?: string;
  title?: string;
}) {
  return (
    <Th
      className={className}
      title={title}
      aria-sort={columnAriaSort(sort, [column])}
    >
      <SortButton
        label={label}
        column={column}
        sort={sort}
        onSort={onSort}
        title={title}
      />
    </Th>
  );
}
