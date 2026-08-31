import { useNavigate } from "@tanstack/react-router";
import { ResponsiveContainer, Treemap } from "recharts";
import type { SpendTree } from "@amazon-king/contracts";
import { EmptyState } from "./states";
import { formatAcos, formatMoney } from "../lib/format";

/**
 * Spend map tab of the /spend explorer: a treemap sized by spend and colored
 * by ACoS. Roots are groups (markets across all markets, campaigns inside
 * one), children the entities within them. Clicking a campaign node opens
 * its campaign detail page.
 */

type AcosBucket = "good" | "acceptable" | "poor";

/** ACoS buckets: under 30% is healthy, past 60% (or no sales at all) is not. */
function acosBucket(acos: number | null): AcosBucket {
  if (acos === null || acos > 0.6) return "poor";
  if (acos >= 0.3) return "acceptable";
  return "good";
}

const BUCKET_FILL: Record<AcosBucket, string> = {
  good: "rgba(52, 211, 153, 0.22)",
  acceptable: "rgba(251, 191, 36, 0.20)",
  poor: "rgba(248, 113, 113, 0.22)",
};
const BUCKET_STROKE: Record<AcosBucket, string> = {
  good: "rgba(52, 211, 153, 0.55)",
  acceptable: "rgba(251, 191, 36, 0.5)",
  poor: "rgba(248, 113, 113, 0.5)",
};

const BUCKET_LEGEND: { bucket: AcosBucket; label: string }[] = [
  { bucket: "good", label: "Good (<30%)" },
  { bucket: "acceptable", label: "Acceptable (30–60%)" },
  { bucket: "poor", label: "Poor (>60% or no sales)" },
];

interface TreemapDatum {
  id: string;
  name: string;
  kind: string;
  spend: number;
  acos: number | null;
  children?: TreemapDatum[];
  // Recharts requires an index signature on treemap data.
  [key: string]: unknown;
}

/** Props Recharts hands the custom content renderer, plus our node fields. */
interface TreemapNodeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  depth?: number;
  id?: string;
  name?: string;
  kind?: string;
  spend?: number;
  acos?: number | null;
  currency: string;
  onOpen: (id: string) => void;
}

function TreemapNode(props: TreemapNodeProps) {
  const {
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    depth = 0,
    id,
    name = "",
    kind,
    spend = 0,
    acos = null,
    currency,
    onOpen,
  } = props;
  if (width <= 0 || height <= 0 || depth === 0) return null;

  const money = formatMoney(spend.toFixed(4), currency);

  if (depth === 1) {
    // Group box: dark container, label above the children.
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          fill="#131316"
          stroke="#3f3f46"
          strokeWidth={1}
        />
        {width > 90 && height > 22 ? (
          <text
            x={x + 8}
            y={y + 15}
            fontSize={11}
            fontWeight={600}
            fill="#d4d4d8"
          >
            {name.length > 30 ? `${name.slice(0, 29)}…` : name}
            <tspan fill="#71717a" fontWeight={400}>
              {`  ${money}`}
            </tspan>
          </text>
        ) : null}
      </g>
    );
  }

  const bucket = acosBucket(acos);
  const clickable = kind === "campaign" && id !== undefined && id !== "other";
  return (
    <g
      onClick={clickable ? () => onOpen(id!) : undefined}
      style={clickable ? { cursor: "pointer" } : undefined}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={BUCKET_FILL[bucket]}
        stroke={BUCKET_STROKE[bucket]}
        strokeWidth={1}
      />
      {width > 60 && height > 34 ? (
        <text
          x={x + 6}
          y={y + height - (height > 52 ? 22 : 8)}
          fontSize={11}
          fill="#e4e4e7"
        >
          {name.length > 24 ? `${name.slice(0, 23)}…` : name}
        </text>
      ) : null}
      {width > 60 && height > 34 ? (
        <text x={x + 6} y={y + height - 8} fontSize={10} fill="#a1a1aa">
          {money}
          {height > 52 ? ` · ${formatAcos(acos)}` : ""}
        </text>
      ) : null}
    </g>
  );
}

export function SpendTreemap({ data }: { data: SpendTree }) {
  const navigate = useNavigate();

  if (data.roots.length === 0) {
    return <EmptyState>No spend in this period.</EmptyState>;
  }

  const tree: TreemapDatum[] = data.roots.map((root) => ({
    id: root.id,
    name: root.name,
    kind: root.kind,
    spend: Number(root.spend),
    acos: root.acos,
    children: root.children.map((child) => ({
      id: child.id,
      name: child.name,
      kind: child.kind,
      spend: Number(child.spend),
      acos: child.acos,
    })),
  }));

  const openNode = (id: string) => {
    void navigate({ to: "/campaigns/$id", params: { id } });
  };

  return (
    <div className="flex flex-col gap-3" aria-label="Spend map">
      <div className="h-[480px]">
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={tree}
            dataKey="spend"
            nameKey="name"
            isAnimationActive={false}
            content={<TreemapNode currency={data.currency} onOpen={openNode} />}
          />
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-400">
        <span className="font-medium text-zinc-500">Performance (ACoS):</span>
        {BUCKET_LEGEND.map(({ bucket, label }) => (
          <span key={bucket} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm border"
              style={{
                backgroundColor: BUCKET_FILL[bucket],
                borderColor: BUCKET_STROKE[bucket],
              }}
            />
            {label}
          </span>
        ))}
        <span className="ml-auto text-zinc-500">Click a box to open it</span>
      </div>
    </div>
  );
}
