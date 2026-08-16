import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState } from "./states";
import { formatCount, formatMoney } from "../lib/format";

/** Series that can be toggled on the dashboard trend chart. */
export type TrendSeries =
  "spend" | "sales" | "royalty" | "profit" | "orders" | "acos";

export const TREND_SERIES_COLORS: Record<TrendSeries, string> = {
  spend: "#d0bcff",
  sales: "#4edea3",
  royalty: "#ffb95f",
  profit: "#a078ff",
  orders: "#93c5fd",
  acos: "#f472b6",
};

interface PerformancePoint {
  date: string;
  cost: string;
  sales: string;
  estimatedRoyalty: string | null;
  estimatedAdProfit?: string | null;
  orders?: number;
}

interface TrendPoint {
  date: string;
  spend: number;
  sales: number;
  royalty: number | null;
  profit: number | null;
  orders: number | null;
  /** ACoS as a percentage (0–100+), null when there were no sales. */
  acos: number | null;
}

function TrendTooltip({
  active,
  payload,
  label,
  currency,
  visible,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: TrendPoint }>;
  label?: string | number;
  currency: string;
  visible: ReadonlySet<TrendSeries>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }
  const rows: Array<{ name: string; value: string; color: string }> = [];
  if (visible.has("spend")) {
    rows.push({
      name: "Spend",
      value: formatMoney(point.spend.toFixed(2), currency),
      color: TREND_SERIES_COLORS.spend,
    });
  }
  if (visible.has("sales")) {
    rows.push({
      name: "Attributed sales",
      value: formatMoney(point.sales.toFixed(2), currency),
      color: TREND_SERIES_COLORS.sales,
    });
  }
  if (visible.has("royalty") && point.royalty !== null) {
    rows.push({
      name: "Estimated royalties",
      value: formatMoney(point.royalty.toFixed(2), currency),
      color: TREND_SERIES_COLORS.royalty,
    });
  }
  if (visible.has("profit") && point.profit !== null) {
    rows.push({
      name: "Estimated ad profit",
      value: formatMoney(point.profit.toFixed(2), currency),
      color: point.profit >= 0 ? "#4edea3" : "#f87171",
    });
  }
  if (visible.has("orders") && point.orders !== null) {
    rows.push({
      name: "Orders",
      value: formatCount(point.orders),
      color: TREND_SERIES_COLORS.orders,
    });
  }
  if (visible.has("acos") && point.acos !== null) {
    rows.push({
      name: "ACoS",
      value: `${point.acos.toFixed(1)}%`,
      color: TREND_SERIES_COLORS.acos,
    });
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
      {rows.map((row) => (
        <p key={row.name} style={{ margin: 0, color: row.color }}>
          {row.name}: {row.value}
        </p>
      ))}
    </div>
  );
}

export function PerformanceTrendChart({
  daily,
  currency,
  showProfit = false,
  visible,
}: {
  daily: readonly PerformancePoint[];
  currency: string;
  showProfit?: boolean;
  /** Series to draw. Defaults to spend/sales/royalty (+ profit when shown). */
  visible?: readonly TrendSeries[];
}) {
  if (daily.length === 0) {
    return <EmptyState>No daily trend data available yet.</EmptyState>;
  }

  const data: TrendPoint[] = daily.map((point) => {
    const royalty =
      point.estimatedRoyalty === null ? null : Number(point.estimatedRoyalty);
    const spend = Number(point.cost);
    const sales = Number(point.sales);
    return {
      date: point.date,
      spend,
      sales,
      royalty,
      // The dashboard summary omits per-day profit; derive it (royalty −
      // spend) so the tooltip can show it without an API change.
      profit:
        point.estimatedAdProfit == null
          ? royalty === null
            ? null
            : royalty - spend
          : Number(point.estimatedAdProfit),
      orders: point.orders ?? null,
      acos: sales > 0 ? (spend / sales) * 100 : null,
    };
  });
  const hasRoyaltyData = data.some((point) => point.royalty !== null);
  const hasProfitData =
    showProfit && data.some((point) => point.profit !== null);
  const hasOrdersData = data.some((point) => point.orders !== null);
  const hasAcosData = data.some((point) => point.acos !== null);

  const visibleSet = new Set<TrendSeries>(
    visible ??
      ([
        "spend",
        "sales",
        "royalty",
        ...(showProfit ? ["profit"] : []),
      ] as TrendSeries[]),
  );
  const show = (series: TrendSeries, hasData: boolean) =>
    visibleSet.has(series) && hasData;
  const showRightAxis =
    show("orders", hasOrdersData) || show("acos", hasAcosData);

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
        <ComposedChart data={data}>
          <defs>
            <linearGradient id="lumina-glow-spend" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={TREND_SERIES_COLORS.spend}
                stopOpacity={0.2}
              />
              <stop
                offset="100%"
                stopColor={TREND_SERIES_COLORS.spend}
                stopOpacity={0}
              />
            </linearGradient>
            <linearGradient id="lumina-glow-sales" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={TREND_SERIES_COLORS.sales}
                stopOpacity={0.2}
              />
              <stop
                offset="100%"
                stopColor={TREND_SERIES_COLORS.sales}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
          <XAxis dataKey="date" stroke="#958ea0" fontSize={12} />
          <YAxis yAxisId="left" stroke="#958ea0" fontSize={12} />
          {showRightAxis ? (
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#958ea0"
              fontSize={12}
            />
          ) : null}
          <Tooltip
            content={<TrendTooltip currency={currency} visible={visibleSet} />}
          />
          <Legend />
          {profitableBands.map((band) => (
            <ReferenceArea
              key={`${band.x1}-${band.x2}`}
              x1={band.x1}
              x2={band.x2}
              fill="#4edea3"
              fillOpacity={0.08}
              strokeOpacity={0}
              yAxisId="left"
            />
          ))}
          {show("profit", hasProfitData) ? (
            <ReferenceLine y={0} stroke="#52525b" yAxisId="left" />
          ) : null}
          {show("spend", true) ? (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="spend"
              name="Spend"
              stroke={TREND_SERIES_COLORS.spend}
              strokeWidth={1.5}
              fill="url(#lumina-glow-spend)"
              dot={false}
            />
          ) : null}
          {show("sales", true) ? (
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="sales"
              name="Attributed sales"
              stroke={TREND_SERIES_COLORS.sales}
              strokeWidth={1.5}
              fill="url(#lumina-glow-sales)"
              dot={false}
            />
          ) : null}
          {show("royalty", hasRoyaltyData) ? (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="royalty"
              name="Estimated royalties"
              stroke={TREND_SERIES_COLORS.royalty}
              strokeDasharray="5 4"
              dot={false}
            />
          ) : null}
          {show("profit", hasProfitData) ? (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="profit"
              name="Estimated ad profit"
              stroke={TREND_SERIES_COLORS.profit}
              strokeWidth={2}
              dot={false}
            />
          ) : null}
          {show("orders", hasOrdersData) ? (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="orders"
              name="Orders"
              stroke={TREND_SERIES_COLORS.orders}
              dot={false}
            />
          ) : null}
          {show("acos", hasAcosData) ? (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="acos"
              name="ACoS %"
              stroke={TREND_SERIES_COLORS.acos}
              strokeDasharray="2 3"
              dot={false}
              connectNulls
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
