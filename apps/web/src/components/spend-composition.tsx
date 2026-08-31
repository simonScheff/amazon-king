import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpendBreakdown } from "@amazon-king/contracts";
import { EmptyState } from "./states";
import {
  buildComposition,
  topEntityShare,
  type CompositionArea,
  type CompositionPoint,
} from "../lib/spend";
import { formatMoney } from "../lib/format";

/**
 * Composition tab of the /spend explorer: a 100%-stacked area chart of daily
 * spend share — one area per top entity, the remainder merged into a gray
 * "Everything else" band — with a legend of window totals underneath.
 */

const TOOLTIP_STYLE = {
  backgroundColor: "#1c1c1e",
  border: "1px solid #3f3f46",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  color: "#e5e2e3",
  fontSize: 12,
  padding: "8px 12px",
} as const;

/** Short axis date: "Aug 15". */
function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function CompositionTooltip({
  active,
  payload,
  label,
  areas,
  currency,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{
    dataKey?: string | number;
    value?: number;
    payload?: CompositionPoint;
  }>;
  label?: string | number;
  areas: readonly CompositionArea[];
  currency: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  const dayTotal = areas.reduce(
    (sum, area) => sum + Number(point[area.key] ?? 0),
    0,
  );
  const rows = areas
    .map((area) => ({
      area,
      spend: Number(point[area.key] ?? 0),
    }))
    .filter((row) => row.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  return (
    <div style={TOOLTIP_STYLE}>
      <div className="mb-1 font-medium text-zinc-100">
        {formatDay(String(label))}
      </div>
      {rows.map(({ area, spend }) => (
        <div key={area.key} className="flex items-center gap-2 py-0.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: area.color }}
          />
          <span className="max-w-52 truncate text-zinc-300">{area.name}</span>
          <span className="ml-auto pl-3 tabular-nums text-zinc-100">
            {formatMoney(spend.toFixed(4), currency)}
          </span>
          <span className="w-11 text-right tabular-nums text-zinc-500">
            {dayTotal > 0 ? `${((spend / dayTotal) * 100).toFixed(0)}%` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SpendComposition({ data }: { data: SpendBreakdown }) {
  const { areas, points } = buildComposition(data);
  const top = topEntityShare(data);

  if (areas.length === 0 || Number(data.totals.spend) <= 0) {
    return <EmptyState>No spend in this period.</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-4" aria-label="Daily spend composition">
      {top ? (
        <p className="text-sm text-zinc-400">
          <span className="font-medium text-zinc-100">{top.name}</span> is{" "}
          <span className="font-medium text-zinc-100">
            {(top.share * 100).toFixed(0)}%
          </span>{" "}
          of spend in this period.
        </p>
      ) : null}
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={points}
            stackOffset="expand"
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="#958ea0"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: "#27272a" }}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value: string) => formatDay(value)}
            />
            <YAxis
              stroke="#958ea0"
              fontSize={11}
              width={44}
              tickLine={false}
              axisLine={false}
              tickCount={5}
              domain={[0, 1]}
              tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
            />
            <Tooltip
              content={
                <CompositionTooltip areas={areas} currency={data.currency} />
              }
              cursor={{ stroke: "#3f3f46", strokeDasharray: "4 4" }}
            />
            {areas.map((area) => (
              <Area
                key={area.key}
                type="monotone"
                dataKey={area.key}
                name={area.name}
                stackId="spend"
                stroke={area.color}
                strokeWidth={1.5}
                fill={area.color}
                fillOpacity={0.55}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-wrap gap-2">
        {areas.map((area) => (
          <li
            key={area.key}
            className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: area.color }}
            />
            <span className="max-w-52 truncate text-zinc-300">{area.name}</span>
            <span className="shrink-0 tabular-nums text-zinc-500">
              {formatMoney(area.totalSpend.toFixed(4), data.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
