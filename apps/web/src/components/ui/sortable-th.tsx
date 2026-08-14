import type { Sort } from "../../lib/sorting";
import { Th } from "./table";

/** Column header button that drives table sorting (aria-sort + arrow). */
export function SortableTh<K extends string>({
  label,
  column,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  column: K;
  sort: Sort<K>;
  onSort: (column: K) => void;
  className?: string;
}) {
  const active = sort.key === column;
  return (
    <Th
      className={className}
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-zinc-300"
      >
        {label}
        <span aria-hidden="true" className="w-3">
          {active ? (sort.direction === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    </Th>
  );
}
