import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { KdpDailyProfit, KdpDailyProfitDay } from "@amazon-king/contracts";
import { EmptyState } from "./states";
import { formatDate, formatMoney } from "../lib/format";

/**
 * Daily profit chart for the /kdp-history organic tab: one calendar month of
 * per-day profitability. Days are KDP royalty posting dates — how the KDP
 * dashboard itself scopes and displays the data, and how the import periods
 * are labeled. Stacked bars show the royalty split — estimated
 * ad-attributed (#a078ff) and real organic (#34d399), the same colors as the
 * sales-mix card — against the day's ad spend (red line); the purple line is
 * the running profit total, so its slope shows whether the month is
 * improving. profit = real KDP royalty − ad spend, so it stays honest even
 * when book economics are missing (only the split is).
 */

const AD_ROYALTY_COLOR = "#a078ff";
const ORGANIC_ROYALTY_COLOR = "#34d399";
const SPEND_COLOR = "#f87171";
const CUMULATIVE_COLOR = "#d0bcff";

export interface DailyProfitPoint {
  date: string;
  adRoyalty: number | null;
  organicRoyalty: number | null;
  adSpend: number;
  /** Real daily profit (total KDP royalty − ad spend); null without an import. */
  profit: number | null;
  /** Running profit total, carrying forward across days without an import. */
  cumulative: number;
}

/** Derives per-day numbers and the running profit total from the API days. */
export function buildDailyProfitPoints(
  daily: readonly KdpDailyProfitDay[],
): DailyProfitPoint[] {
  let cumulative = 0;
  return daily.map((day) => {
    const profit = day.profit === null ? null : Number(day.profit);
    if (profit !== null) {
      cumulative += profit;
    }
    return {
      date: day.date,
      adRoyalty: day.adRoyalty === null ? null : Number(day.adRoyalty),
      organicRoyalty:
        day.organicRoyalty === null ? null : Number(day.organicRoyalty),
      adSpend: Number(day.adSpend),
      profit,
      cumulative,
    };
  });
}

function money(value: number | null, currency: string): string {
  return value === null ? "—" : formatMoney(value.toFixed(2), currency);
}

function DailyProfitTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: DailyProfitPoint }>;
  label?: string | number;
  currency: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }
  return (
    <div
      style={{
        backgroundColor: "#1c1c1e",
        border: "1px solid #3f3f46",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        color: "#e5e2e3",
        fontSize: 12,
        padding: "8px 12px",
      }}
    >
      <p style={{ margin: 0, marginBottom: 4 }}>
        {typeof label === "string" ? formatDate(label) : label}
      </p>
      <p style={{ margin: 0, color: AD_ROYALTY_COLOR }}>
        Ad royalty (est.): {money(point.adRoyalty, currency)}
      </p>
      <p style={{ margin: 0, color: "#d4d4d8" }}>
        Organic royalty: {money(point.organicRoyalty, currency)}
      </p>
      <p style={{ margin: 0, color: SPEND_COLOR }}>
        Ad spend: {money(point.adSpend, currency)}
      </p>
      {point.profit !== null ? (
        <p
          style={{
            margin: 0,
            color: point.profit >= 0 ? "#4edea3" : "#f87171",
          }}
        >
          Daily profit: {money(point.profit, currency)}
        </p>
      ) : (
        <p style={{ margin: 0, color: "#958ea0" }}>No KDP import</p>
      )}
      <p style={{ margin: 0, color: CUMULATIVE_COLOR }}>
        Cumulative: {money(point.cumulative, currency)}
      </p>
    </div>
  );
}

export function KdpDailyProfitChart({ data }: { data: KdpDailyProfit }) {
  if (data.daily.length === 0) {
    return (
      <EmptyState>
        {data.ratesAvailable
          ? "No daily profit data for this month."
          : "Exchange rates are not synced yet — run “Sync rates now” from Settings → Profiles to see converted figures."}
      </EmptyState>
    );
  }

  const points = buildDailyProfitPoints(data.daily);

  return (
    <div className="flex flex-col gap-3">
      <div className="h-64" aria-label="Daily profit chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              stroke="#958ea0"
              fontSize={12}
              tickFormatter={(value: string) => value.slice(8)}
            />
            <YAxis stroke="#958ea0" fontSize={12} />
            <Tooltip
              content={<DailyProfitTooltip currency={data.currency} />}
            />
            <Legend />
            <ReferenceLine y={0} stroke="#52525b" />
            <Bar
              dataKey="adRoyalty"
              name="Ad royalty (est.)"
              stackId="royalty"
              fill={AD_ROYALTY_COLOR}
            />
            <Bar
              dataKey="organicRoyalty"
              name="Organic royalty"
              stackId="royalty"
              fill={ORGANIC_ROYALTY_COLOR}
              radius={[2, 2, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="adSpend"
              name="Ad spend"
              stroke={SPEND_COLOR}
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="cumulative"
              name="Cumulative profit"
              stroke={CUMULATIVE_COLOR}
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {data.kdpImported ? null : (
        <p className="text-xs text-zinc-500">
          No KDP import for this month — showing the estimated ad side only.
          Daily profit and organic royalty need a KDP Royalties Estimator
          report.
        </p>
      )}
      {data.economicsMissing ? (
        <p className="text-xs text-zinc-500">
          Some days are missing book economics, so the ad/organic split is
          incomplete there — the daily profit still uses real KDP royalty.
        </p>
      ) : null}
    </div>
  );
}
