import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState } from "./states";
import { formatMoney } from "../lib/format";

interface PerformancePoint {
  date: string;
  cost: string;
  sales: string;
  estimatedRoyalty: string | null;
  estimatedAdProfit?: string | null;
}

interface TrendPoint {
  date: string;
  spend: number;
  sales: number;
  royalty: number | null;
  profit: number | null;
}

function TrendTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: TrendPoint }>;
  label?: string | number;
  currency: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }
  const rows: Array<{ name: string; value: number; color: string }> = [
    { name: "Spend", value: point.spend, color: "#f59e0b" },
    { name: "Attributed sales", value: point.sales, color: "#a78bfa" },
  ];
  if (point.royalty !== null) {
    rows.push({
      name: "Estimated royalties",
      value: point.royalty,
      color: "#34d399",
    });
  }
  if (point.profit !== null) {
    rows.push({
      name: "Estimated ad profit",
      value: point.profit,
      color: point.profit >= 0 ? "#34d399" : "#f87171",
    });
  }
  return (
    <div
      style={{
        backgroundColor: "#1a2030",
        border: "1px solid #323a4e",
        borderRadius: 12,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        color: "#e3e6ee",
        fontSize: 12,
        padding: "8px 12px",
      }}
    >
      <p style={{ margin: 0, marginBottom: 4 }}>{label}</p>
      {rows.map((row) => (
        <p key={row.name} style={{ margin: 0, color: row.color }}>
          {row.name}: {formatMoney(row.value.toFixed(2), currency)}
        </p>
      ))}
    </div>
  );
}

export function PerformanceTrendChart({
  daily,
  currency,
  showProfit = false,
}: {
  daily: readonly PerformancePoint[];
  currency: string;
  showProfit?: boolean;
}) {
  if (daily.length === 0) {
    return <EmptyState>No daily trend data available yet.</EmptyState>;
  }

  const data: TrendPoint[] = daily.map((point) => {
    const royalty =
      point.estimatedRoyalty === null ? null : Number(point.estimatedRoyalty);
    const spend = Number(point.cost);
    return {
      date: point.date,
      spend,
      sales: Number(point.sales),
      royalty,
      // The dashboard summary omits per-day profit; derive it (royalty −
      // spend) so the tooltip can show it without an API change.
      profit:
        point.estimatedAdProfit == null
          ? royalty === null
            ? null
            : royalty - spend
          : Number(point.estimatedAdProfit),
    };
  });
  const hasRoyaltyData = data.some((point) => point.royalty !== null);
  const hasProfitData =
    showProfit && data.some((point) => point.profit !== null);

  // Shade days where estimated royalties exceed spend. A day band runs from
  // its own tick to the next day's tick; the final day borrows the previous
  // interval so it stays visible.
  const profitableBands: Array<{ x1: string; x2: string }> = [];
  if (hasRoyaltyData) {
    data.forEach((point, index) => {
      if (point.royalty === null || point.royalty <= point.spend) return;
      const next = data[index + 1];
      const previous = data[index - 1];
      if (next) {
        profitableBands.push({ x1: point.date, x2: next.date });
      } else if (previous) {
        profitableBands.push({ x1: previous.date, x2: point.date });
      }
    });
  }

  return (
    <div className="h-64" aria-label="Daily performance trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid stroke="#242a3a" strokeDasharray="3 3" />
          <XAxis dataKey="date" stroke="#7b8496" fontSize={12} />
          <YAxis stroke="#7b8496" fontSize={12} />
          <Tooltip content={<TrendTooltip currency={currency} />} />
          <Legend />
          {profitableBands.map((band) => (
            <ReferenceArea
              key={`${band.x1}-${band.x2}`}
              x1={band.x1}
              x2={band.x2}
              fill="#34d399"
              fillOpacity={0.08}
              strokeOpacity={0}
            />
          ))}
          {hasProfitData ? <ReferenceLine y={0} stroke="#4b5568" /> : null}
          <Line
            type="monotone"
            dataKey="spend"
            name="Spend"
            stroke="#f59e0b"
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="sales"
            name="Attributed sales"
            stroke="#a78bfa"
            dot={false}
          />
          {hasRoyaltyData ? (
            <Line
              type="monotone"
              dataKey="royalty"
              name="Estimated royalties"
              stroke="#34d399"
              strokeDasharray="5 4"
              dot={false}
            />
          ) : null}
          {hasProfitData ? (
            <Line
              type="monotone"
              dataKey="profit"
              name="Estimated ad profit"
              stroke="#c4b5fd"
              strokeWidth={2}
              dot={false}
            />
          ) : null}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
