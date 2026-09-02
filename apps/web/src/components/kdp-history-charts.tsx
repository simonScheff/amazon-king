import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { KdpHistorySeries } from "@amazon-king/contracts";
import { EmptyState } from "./states";
import {
  formatCount,
  formatMoney,
  formatMonth,
  formatPercentChange,
  percentChange,
} from "../lib/format";

/**
 * Charts for the /kdp-history page (docs/kdp-royalty-import-plan.md §6).
 * Series are single-currency by construction; the royalty trend labels every
 * line with its currency and never sums across them. The sales mix sums units
 * (never money) and clamps organic at zero — ad attribution and KDP never
 * perfectly align.
 */

const TREND_LINE_COLORS = [
  "#a078ff",
  "#4edea3",
  "#ffb95f",
  "#93c5fd",
  "#f472b6",
  "#d0bcff",
  "#f87171",
  "#5eead4",
];

const AD_UNITS_COLOR = "#a078ff";
const ORGANIC_UNITS_COLOR = "#34d399";

interface RoyaltyTrendLine {
  /** Series identity: `${bookId}:${profileId}`; the datum key. */
  key: string;
  /** Legend label: book title with market and currency — lines never mix currencies. */
  name: string;
  title: string;
  countryCode: string;
  currency: string;
  color: string;
}

type RoyaltyTrendPoint = { month: string } & Record<
  string,
  number | null | string
>;

/** One x-axis point per month, one key per book × market line. */
export function buildRoyaltyTrend(series: readonly KdpHistorySeries[]): {
  data: RoyaltyTrendPoint[];
  lines: RoyaltyTrendLine[];
} {
  const months = [
    ...new Set(series.flatMap((entry) => entry.months.map((m) => m.month))),
  ].sort();
  const lines = series.map((entry, index) => ({
    key: `${entry.bookId}:${entry.profileId}`,
    name: `${entry.title} (${entry.countryCode} · ${entry.currency})`,
    title: entry.title,
    countryCode: entry.countryCode,
    currency: entry.currency,
    color: TREND_LINE_COLORS[index % TREND_LINE_COLORS.length]!,
  }));
  const data = months.map((month) => {
    const point: RoyaltyTrendPoint = { month };
    for (let i = 0; i < series.length; i += 1) {
      const entry = series[i]!;
      const value = entry.months.find((m) => m.month === month)?.royaltyPerSale;
      point[lines[i]!.key] = value == null ? null : Number(value);
    }
    return point;
  });
  return { data, lines };
}

export interface SalesMixPoint {
  month: string;
  ad: number;
  organic: number;
}

/**
 * Monthly ad vs. organic units summed over the given series. Organic is
 * clamped at zero per series-month before summing: ad-attributed units can
 * exceed what KDP recorded for a book in a month (ad attribution windows
 * vs. KDP royalty posting months), and a negative bar would be nonsense.
 */
export function buildSalesMix(
  series: readonly KdpHistorySeries[],
): SalesMixPoint[] {
  const months = [
    ...new Set(series.flatMap((entry) => entry.months.map((m) => m.month))),
  ].sort();
  return months.map((month) => {
    let ad = 0;
    let organic = 0;
    for (const entry of series) {
      const m = entry.months.find((item) => item.month === month);
      if (!m) continue;
      ad += m.adUnits;
      organic += Math.max(
        0,
        m.kdpStandardUnits + m.kdpExpandedUnits - m.adUnits,
      );
    }
    return { month, ad, organic };
  });
}

/** Headline sums over the visible months, for the stat tiles. */
export function buildSalesTotals(points: readonly SalesMixPoint[]): {
  total: number;
  ad: number;
  organic: number;
} {
  let ad = 0;
  let organic = 0;
  for (const point of points) {
    ad += point.ad;
    organic += point.organic;
  }
  return { total: ad + organic, ad, organic };
}

/** Part of the total as a fraction; null when there is no base. */
export function unitShare(part: number, total: number): number | null {
  if (total <= 0) return null;
  return part / total;
}

/** First-of-month ISO date of the (UTC) month containing `now`. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

const TOOLTIP_STYLE = {
  backgroundColor: "#1c1c1e",
  border: "1px solid #3f3f46",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  color: "#e5e2e3",
  fontSize: 12,
  padding: "8px 12px",
} as const;

function RoyaltyTrendTooltip({
  active,
  payload,
  label,
  lines,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{
    dataKey?: string | number;
    value?: number | null;
  }>;
  label?: string | number;
  lines: readonly RoyaltyTrendLine[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const byKey = new Map(lines.map((line) => [line.key, line]));
  const rows = payload
    .map((entry) => ({
      line: byKey.get(String(entry.dataKey)),
      value: entry.value,
    }))
    .filter(
      (row): row is { line: RoyaltyTrendLine; value: number } =>
        row.line !== undefined && row.value != null,
    );
  if (rows.length === 0) return null;
  return (
    <div style={TOOLTIP_STYLE}>
      <p
        style={{
          margin: 0,
          marginBottom: 6,
          fontWeight: 600,
          color: "#fafafa",
        }}
      >
        {formatMonth(String(label))}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map(({ line, value }) => (
          <p
            key={line.key}
            style={{
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 9999,
                backgroundColor: line.color,
                flexShrink: 0,
              }}
            />
            <span style={{ color: "#a1a1aa" }}>{line.name}</span>
            <span
              style={{
                marginLeft: "auto",
                paddingLeft: 12,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatMoney(value.toFixed(2), line.currency)}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

/** Compact legend chip: color dot + truncated title + market/currency. */
function TrendLegendChip({ line }: { line: RoyaltyTrendLine }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-xs" title={line.name}>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: line.color }}
      />
      <span className="max-w-44 truncate text-zinc-300">{line.title}</span>
      <span className="shrink-0 text-zinc-500">
        {line.countryCode} · {line.currency}
      </span>
    </li>
  );
}

/** Latest royalty per sale for one series, with month-over-month delta. */
function TrendStatTile({
  line,
  entry,
}: {
  line: RoyaltyTrendLine;
  entry: KdpHistorySeries;
}) {
  const points = entry.months
    .filter((m) => m.royaltyPerSale != null)
    .sort((a, b) => a.month.localeCompare(b.month));
  const latest = points.at(-1);
  if (!latest) return null;
  const previous = points.at(-2);
  const delta = percentChange(
    Number(latest.royaltyPerSale),
    previous ? Number(previous.royaltyPerSale) : null,
  );
  return (
    <div
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5"
      title={line.name}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: line.color }}
        />
        <span className="truncate text-zinc-300">{line.title}</span>
        <span className="shrink-0 text-zinc-500">
          {line.countryCode} · {line.currency}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-lg font-semibold tabular-nums text-zinc-100">
          {formatMoney(latest.royaltyPerSale, entry.currency)}
        </span>
        {delta == null ? (
          <span className="text-xs text-zinc-500">—</span>
        ) : (
          <span
            className={`text-xs font-medium tabular-nums ${
              delta > 0
                ? "text-emerald-400"
                : delta < 0
                  ? "text-rose-400"
                  : "text-zinc-500"
            }`}
          >
            {delta > 0 ? "▲ " : delta < 0 ? "▼ " : ""}
            {formatPercentChange(delta).replace(/^[+-]/, "")}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-zinc-500">
        {formatMonth(latest.month)}
        {previous ? ` · vs ${formatMonth(previous.month)}` : ""}
      </div>
    </div>
  );
}

/** Net royalty per sale over time — one line per book × market series. */
export function RoyaltyTrendChart({
  series,
}: {
  series: readonly KdpHistorySeries[];
}) {
  const { data, lines } = buildRoyaltyTrend(series);
  if (data.length === 0) {
    return <EmptyState>No royalty history yet.</EmptyState>;
  }

  // Zoom the y-axis to the data range (never zero-based): monthly royalty
  // moves in cents, and a zero baseline would flatten every line.
  const values = data.flatMap((point) =>
    lines
      .map((line) => point[line.key])
      .filter((v): v is number => typeof v === "number"),
  );
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.1, 0.5);
  const yDomain: [number, number] =
    values.length === 0
      ? [0, 1]
      : [Math.max(0, min - span * 0.2), max + span * 0.2];

  return (
    <div
      className="flex flex-col gap-4"
      aria-label="Net royalty per sale trend"
    >
      <ul className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5">
        {lines.map((line) => (
          <TrendLegendChip key={line.key} line={line} />
        ))}
      </ul>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              {lines.map((line, index) => (
                <linearGradient
                  key={line.key}
                  id={`royalty-fill-${index}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={line.color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={line.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="month"
              stroke="#958ea0"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: "#27272a" }}
              tickMargin={8}
              tickFormatter={(value: string) => formatMonth(value)}
            />
            <YAxis
              stroke="#958ea0"
              fontSize={11}
              width={44}
              tickLine={false}
              axisLine={false}
              tickCount={5}
              domain={yDomain}
              tickFormatter={(value: number) => value.toFixed(2)}
            />
            <Tooltip
              content={<RoyaltyTrendTooltip lines={lines} />}
              cursor={{ stroke: "#3f3f46", strokeDasharray: "4 4" }}
            />
            {lines.map((line, index) => (
              <Area
                key={line.key}
                type="monotone"
                dataKey={line.key}
                name={line.name}
                stroke={line.color}
                strokeWidth={2}
                fill={`url(#royalty-fill-${index})`}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {lines.map((line, index) => (
          <TrendStatTile key={line.key} line={line} entry={series[index]!} />
        ))}
      </div>
    </div>
  );
}

function SalesMixTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: SalesMixPoint }>;
  label?: string | number;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div style={TOOLTIP_STYLE}>
      <p style={{ margin: 0, marginBottom: 4 }}>{label}</p>
      <p style={{ margin: 0, color: AD_UNITS_COLOR }}>
        Ad-attributed units: {formatCount(point.ad)}
      </p>
      <p style={{ margin: 0, color: ORGANIC_UNITS_COLOR }}>
        Organic units: {formatCount(point.organic)}
      </p>
    </div>
  );
}

/** Stacked ad vs. organic units per month for the selected book (or all). */
export function SalesMixChart({
  series,
}: {
  series: readonly KdpHistorySeries[];
}) {
  const data = buildSalesMix(series);
  if (data.length === 0) {
    return <EmptyState>No sales history yet.</EmptyState>;
  }
  return (
    <div className="h-64" aria-label="Sales mix by month">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data}>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
          <XAxis
            dataKey="month"
            stroke="#958ea0"
            fontSize={12}
            tickFormatter={(value: string) => formatMonth(value)}
          />
          <YAxis stroke="#958ea0" fontSize={12} allowDecimals={false} />
          <Tooltip content={<SalesMixTooltip />} />
          <Legend />
          <Bar
            dataKey="ad"
            name="Ad-attributed units"
            stackId="units"
            fill={AD_UNITS_COLOR}
          />
          <Bar
            dataKey="organic"
            name="Organic units"
            stackId="units"
            fill={ORGANIC_UNITS_COLOR}
            radius={[2, 2, 0, 0]}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
