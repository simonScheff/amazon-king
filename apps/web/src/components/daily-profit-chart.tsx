import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState } from "./states";
import { formatMoney } from "../lib/format";

interface ProfitabilityPoint {
  date: string;
  cost: string;
  estimatedRoyalty: string | null;
  estimatedAdProfit?: string | null;
}

export interface DailyProfitPoint {
  date: string;
  /** Estimated ad profit (royalty − spend); null when economics are missing. */
  profit: number | null;
  /** Running profit total, carrying forward across days without data. */
  cumulative: number;
}

/** Derives per-day profit and its running total from daily summary points. */
export function buildDailyProfitability(
  daily: readonly ProfitabilityPoint[],
): DailyProfitPoint[] {
  let cumulative = 0;
  return daily.map((point) => {
    const spend = Number(point.cost);
    const royalty =
      point.estimatedRoyalty === null ? null : Number(point.estimatedRoyalty);
    const profit =
      point.estimatedAdProfit == null
        ? royalty === null
          ? null
          : royalty - spend
        : Number(point.estimatedAdProfit);
    if (profit !== null) {
      cumulative += profit;
    }
    return { date: point.date, profit, cumulative };
  });
}

function ProfitTooltip({
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
      <p style={{ margin: 0, marginBottom: 4 }}>{label}</p>
      {point.profit !== null ? (
        <p
          style={{
            margin: 0,
            color: point.profit >= 0 ? "#4edea3" : "#f87171",
          }}
        >
          Daily profit: {formatMoney(point.profit.toFixed(2), currency)}
        </p>
      ) : (
        <p style={{ margin: 0, color: "#958ea0" }}>No economics data</p>
      )}
      <p style={{ margin: 0, color: "#d0bcff" }}>
        Cumulative: {formatMoney(point.cumulative.toFixed(2), currency)}
      </p>
    </div>
  );
}

/**
 * Daily estimated ad profit as green/red bars around a zero line, with a
 * cumulative profit line: bars show which days made or lost money, and the
 * line's slope shows whether profitability is improving over time.
 */
export function DailyProfitChart({
  daily,
  currency,
}: {
  daily: readonly ProfitabilityPoint[];
  currency: string;
}) {
  if (daily.length === 0) {
    return <EmptyState>No daily trend data available yet.</EmptyState>;
  }

  const data = buildDailyProfitability(daily);

  return (
    <div className="h-56" aria-label="Daily profit chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data}>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
          <XAxis dataKey="date" stroke="#958ea0" fontSize={12} />
          <YAxis stroke="#958ea0" fontSize={12} />
          <Tooltip content={<ProfitTooltip currency={currency} />} />
          <Legend />
          <ReferenceLine y={0} stroke="#52525b" />
          <Bar dataKey="profit" name="Daily profit" radius={[2, 2, 0, 0]}>
            {data.map((point) => (
              <Cell
                key={point.date}
                fill={
                  point.profit === null
                    ? "#3f3f46"
                    : point.profit >= 0
                      ? "#4edea3"
                      : "#f87171"
                }
              />
            ))}
          </Bar>
          <Line
            type="monotone"
            dataKey="cumulative"
            name="Cumulative profit"
            stroke="#d0bcff"
            strokeWidth={2}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
