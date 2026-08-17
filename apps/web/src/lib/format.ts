import type { CurrencyCode, DecimalString } from "@amazon-king/contracts";

/**
 * Display-only money formatting. Monetary data arrives as string-encoded
 * decimals; we convert to Number only for rendering — never for arithmetic.
 */
export function formatMoney(
  value: DecimalString | null | undefined,
  currency: CurrencyCode | string,
): string {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(n);
}

/** ACoS is a fraction (spend / attributed sales). Render as a percentage. */
export function formatAcos(acos: number | null | undefined): string {
  if (acos == null || !Number.isFinite(acos)) return "—";
  return `${(acos * 100).toFixed(1)}%`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}

/**
 * Period-over-period change as a fraction of |previous| (0.12 = +12%).
 * Null when the previous value is zero or unknown — a percentage change has
 * no meaningful base then.
 */
export function percentChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current == null || previous == null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Format a fractional change as a signed percentage, e.g. 0.123 → "+12.3%". */
export function formatPercentChange(fraction: number): string {
  const pct = fraction * 100;
  const rounded = Math.abs(pct) < 0.05 ? 0 : pct; // avoid "-0.0%"
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = dateOnly
    ? new Date(
        Number(dateOnly[1]),
        Number(dateOnly[2]) - 1,
        Number(dateOnly[3]),
      )
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human label for a recommendation type enum value. */
export function labelize(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
