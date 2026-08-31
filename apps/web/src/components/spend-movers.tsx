import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpendBreakdown } from "@amazon-king/contracts";
import { Badge } from "./ui/badge";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Table, Td, Th } from "./ui/table";
import { EmptyState } from "./states";
import {
  buildMoverRows,
  buildWeeklyRanks,
  windowDays,
  type MoverStatus,
  type WeeklyRankLine,
} from "../lib/spend";
import { formatMoney, formatPercentChange } from "../lib/format";

/**
 * Movers tab of the /spend explorer: a weekly rank bump chart (rank 1 = top
 * spender of the week) above a this-period-vs-previous table with 14-day
 * sparklines. Needs at least 14 days — weekly ranks are meaningless below
 * two weeks of data.
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

const STATUS_BADGE: Record<
  MoverStatus,
  { label: string; tone: "info" | "success" | "danger" | "neutral" }
> = {
  new: { label: "New", tone: "info" },
  rising: { label: "Rising", tone: "success" },
  fading: { label: "Fading", tone: "danger" },
  stable: { label: "Stable", tone: "neutral" },
};

function RankTooltip({
  active,
  payload,
  label,
  lines,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: string | number; value?: number }>;
  label?: string | number;
  lines: readonly WeeklyRankLine[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload
    .map((entry) => ({
      line: lines.find((line) => line.id === String(entry.dataKey)),
      rank: entry.value,
    }))
    .filter(
      (row): row is { line: WeeklyRankLine; rank: number } =>
        row.line !== undefined && typeof row.rank === "number",
    )
    .sort((a, b) => a.rank - b.rank);
  if (rows.length === 0) return null;
  return (
    <div style={TOOLTIP_STYLE}>
      <div className="mb-1 font-medium text-zinc-100">{String(label)}</div>
      {rows.map(({ line, rank }) => (
        <div key={line.id} className="flex items-center gap-2 py-0.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: line.color }}
          />
          <span className="max-w-52 truncate text-zinc-300">{line.name}</span>
          <span className="ml-auto pl-3 tabular-nums text-zinc-100">
            #{rank}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Tiny 14-day spend trend, no axes. */
function Sparkline({ points }: { points: { date: string; spend: number }[] }) {
  if (points.length === 0) return <span className="text-zinc-600">—</span>;
  return (
    <div className="h-7 w-24" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={points}
          margin={{ top: 1, right: 0, bottom: 0, left: 0 }}
        >
          <Area
            type="monotone"
            dataKey="spend"
            stroke="#93c5fd"
            strokeWidth={1.5}
            fill="#93c5fd"
            fillOpacity={0.18}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendMovers({ data }: { data: SpendBreakdown }) {
  if (windowDays(data) < 14) {
    return (
      <Card>
        <CardBody>
          <EmptyState>
            Movers needs at least 14 days — pick a longer date range to compare
            weekly ranks and periods.
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  const { weeks, lines, seriesCount } = buildWeeklyRanks(data);
  const rows = buildMoverRows(data);

  if (rows.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState>No spend in this period.</EmptyState>
        </CardBody>
      </Card>
    );
  }

  const chartData = weeks.map((week, index) => {
    const point: Record<string, string | number | null> = {
      week: week.label,
    };
    for (const line of lines) {
      point[line.id] = line.ranks[index] ?? null;
    }
    return point;
  });

  return (
    <>
      <Card>
        <CardHeader
          title="Rank over time"
          description="Weekly spend rank — rank 1 is the week's top spender. Lines start when an entity first spends."
        />
        <CardBody>
          <div className="h-72" aria-label="Weekly spend rank">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid stroke="#27272a" vertical={false} />
                <XAxis
                  dataKey="week"
                  stroke="#958ea0"
                  fontSize={12}
                  tickLine={false}
                  axisLine={{ stroke: "#27272a" }}
                  tickMargin={8}
                />
                <YAxis
                  stroke="#958ea0"
                  fontSize={11}
                  width={32}
                  tickLine={false}
                  axisLine={false}
                  reversed
                  allowDecimals={false}
                  domain={[1, Math.max(seriesCount, 2)]}
                />
                <Tooltip
                  content={<RankTooltip lines={lines} />}
                  cursor={{ stroke: "#3f3f46", strokeDasharray: "4 4" }}
                />
                {lines.map((line) => (
                  <Line
                    key={line.id}
                    type="monotone"
                    dataKey={line.id}
                    name={line.name}
                    stroke={line.color}
                    strokeWidth={2}
                    dot={{ r: 2.5, strokeWidth: 0, fill: line.color }}
                    activeDot={{ r: 3.5, strokeWidth: 0 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="This period vs previous period"
          description="Current-window spend against the immediately preceding window of the same length, biggest increase first."
        />
        <Table>
          <thead>
            <tr>
              <Th>Entity</Th>
              <Th>This period</Th>
              <Th>Previous period</Th>
              <Th>Change</Th>
              <Th>14-day trend</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = STATUS_BADGE[row.status];
              const color =
                lines.find((line) => line.id === row.id)?.color ?? "#71717a";
              return (
                <tr key={row.id}>
                  <Td className="max-w-64 align-middle">
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="truncate text-sm text-zinc-200">
                        {row.name}
                      </span>
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm tabular-nums">
                    {formatMoney(row.current.toFixed(4), data.currency)}
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm tabular-nums text-zinc-400">
                    {formatMoney(row.previous.toFixed(4), data.currency)}
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm">
                    {row.status === "new" ? (
                      <Badge tone="info">New</Badge>
                    ) : row.change === null ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      <span
                        className={`tabular-nums ${
                          row.change > 0
                            ? "text-emerald-400"
                            : row.change < 0
                              ? "text-rose-400"
                              : "text-zinc-500"
                        }`}
                      >
                        {row.change > 0 ? "▲ " : row.change < 0 ? "▼ " : ""}
                        {formatPercentChange(row.change)}
                      </span>
                    )}
                  </Td>
                  <Td className="align-middle">
                    <Sparkline points={row.sparkline} />
                  </Td>
                  <Td className="whitespace-nowrap align-middle">
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
