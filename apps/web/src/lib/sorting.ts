/**
 * Display-only column sorting for dashboard tables. Money arrives as
 * string-encoded decimals; callers convert to Number for ordering — sorting
 * never feeds back into monetary arithmetic.
 */

export type SortDirection = "asc" | "desc";

export interface Sort<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * Compare two sortable cell values. Missing values (no ACoS, unavailable
 * profit) always sort last regardless of direction.
 */
export function compareNullable(
  a: number | string | null,
  b: number | string | null,
  direction: SortDirection,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result =
    typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b)
      : Number(a) - Number(b);
  return direction === "asc" ? result : -result;
}

/**
 * Next sort state after a header click: same column toggles direction; a new
 * column starts ascending for text and descending for numbers.
 */
export function nextSort<K extends string>(
  current: Sort<K>,
  column: K,
  textColumns: readonly K[],
): Sort<K> {
  if (current.key === column) {
    return {
      key: column,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  return {
    key: column,
    direction: textColumns.includes(column) ? "asc" : "desc",
  };
}
