import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
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

  const data = daily.map((point) => ({
    date: point.date,
    spend: Number(point.cost),
    sales: Number(point.sales),
    royalty:
      point.estimatedRoyalty === null ? null : Number(point.estimatedRoyalty),
    profit:
      point.estimatedAdProfit == null ? null : Number(point.estimatedAdProfit),
  }));
  const hasRoyaltyData = data.some((point) => point.royalty !== null);
  const hasProfitData =
    showProfit && data.some((point) => point.profit !== null);

  return (
    <div className="h-64" aria-label="Daily performance trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
          <XAxis dataKey="date" stroke="#71717a" fontSize={12} />
          <YAxis stroke="#71717a" fontSize={12} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#18181b",
              border: "1px solid #3f3f46",
              fontSize: 12,
            }}
            formatter={(value) => [
              typeof value === "number"
                ? formatMoney(value.toFixed(2), currency)
                : String(value),
            ]}
          />
          <Legend />
          {hasProfitData ? <ReferenceLine y={0} stroke="#52525b" /> : null}
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
            stroke="#38bdf8"
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
              stroke="#c084fc"
              strokeWidth={2}
              dot={false}
            />
          ) : null}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
