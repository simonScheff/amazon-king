import { Link, useParams } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  useCreateChangeSet,
  useRecommendation,
  useRejectRecommendation,
} from "../api/endpoints";
import { useToast } from "../components/toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ErrorState, Loading } from "../components/states";
import { formatDate, formatDateTime, labelize } from "../lib/format";

export function RecommendationDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const rec = useRecommendation(id);
  const reject = useRejectRecommendation(id);
  const createChangeSet = useCreateChangeSet();
  const toast = useToast();

  if (rec.isPending) return <Loading />;
  if (rec.error) return <ErrorState error={rec.error} />;
  if (!rec.data) return null;

  const r = rec.data;
  const pending = r.state === "pending";

  const valueChart =
    r.currentValue != null && r.proposedValue != null
      ? [
          { name: "Current", value: Number(r.currentValue) },
          { name: "Proposed", value: Number(r.proposedValue) },
        ]
      : null;

  const entities: Array<[string, string | null]> = [
    ["Profile", r.profileId],
    ["Campaign", r.campaignId],
    ["Ad group", r.adGroupId],
    ["Target", r.targetId],
    ["Search term", r.searchTerm],
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <p className="text-sm">
        <Link to="/recommendations" className="text-sky-400 hover:underline">
          ← Recommendations
        </Link>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">
          {labelize(r.type)}
        </h1>
        <Badge tone={r.priority <= 2 ? "warning" : "neutral"}>
          Priority {r.priority}
        </Badge>
        <Badge tone="info">{r.state}</Badge>
        <span className="ml-auto text-xs text-zinc-500">
          Rule {r.ruleVersion} · confidence {Math.round(r.confidence * 100)}%
        </span>
      </div>

      <Card>
        <CardHeader title="Finding" />
        <CardBody>
          <p className="text-sm text-zinc-200">{r.rationale}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm md:grid-cols-3">
            {entities
              .filter(([, v]) => v != null)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-zinc-500">{label}</dt>
                  <dd className="font-mono text-xs text-zinc-300">{value}</dd>
                </div>
              ))}
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Current vs proposed" />
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-zinc-800 px-3 py-2">
              <p className="text-xs text-zinc-500">Current value</p>
              <p className="text-base font-semibold text-zinc-100">
                {r.currentValue ?? "—"}
              </p>
            </div>
            <div className="rounded-md border border-sky-900 bg-sky-950/40 px-3 py-2">
              <p className="text-xs text-zinc-500">Proposed value</p>
              <p className="text-base font-semibold text-sky-300">
                {r.proposedValue ?? "—"}
              </p>
            </div>
          </div>
          {valueChart && (
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={valueChart}>
                  <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                  <XAxis dataKey="name" stroke="#71717a" fontSize={12} />
                  <YAxis stroke="#71717a" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#18181b",
                      border: "1px solid #3f3f46",
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="value" fill="#38bdf8" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Evidence & guardrails" />
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
            <div>
              <dt className="text-xs text-zinc-500">Evidence window</dt>
              <dd>
                {formatDate(r.evidenceWindow.start)} –{" "}
                {formatDate(r.evidenceWindow.end)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Data freshness</dt>
              <dd>{formatDateTime(r.dataFreshness)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Expires</dt>
              <dd>{formatDateTime(r.expiresAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Created</dt>
              <dd>{formatDateTime(r.createdAt)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-zinc-500">
            Guardrails: bid changes are clamped per cooldown period, writes
            require a fresh before-state re-check, and this recommendation
            expires when its data goes stale.
          </p>
        </CardBody>
      </Card>

      {pending && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={createChangeSet.isPending}
            onClick={() =>
              createChangeSet.mutate(
                { recommendationIds: [r.id] },
                {
                  onSuccess: (cs) =>
                    toast(
                      `Added to change set ${cs.id} — review in Change center`,
                    ),
                  onError: (err) =>
                    toast(`Approve failed: ${err.message}`, "error"),
                },
              )
            }
          >
            {createChangeSet.isPending
              ? "Approving…"
              : "Approve (create change set)"}
          </Button>
          <Button
            variant="danger"
            disabled={reject.isPending}
            onClick={() =>
              reject.mutate(undefined, {
                onSuccess: () => toast("Recommendation rejected"),
                onError: (err) =>
                  toast(`Reject failed: ${err.message}`, "error"),
              })
            }
          >
            Reject
          </Button>
          {/* API-GAP: no protect-entity endpoint exists in plan §11 yet. */}
          <Button
            disabled
            title="Protecting entities is not supported by the API yet"
          >
            Protect entity
          </Button>
        </div>
      )}
    </div>
  );
}
