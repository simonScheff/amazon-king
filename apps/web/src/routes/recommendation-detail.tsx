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
import { CampaignLink } from "../components/campaign-link";
import { CannibalizationResolution } from "../components/cannibalization-resolution";
import { ConversionResolution } from "../components/conversion-resolution";
import { ErrorState, Loading } from "../components/states";
import { formatDate, formatDateTime, labelize } from "../lib/format";
import { getRecommendationActionDetails } from "../lib/recommendation-action";

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
  if (r.type === "cannibalization_conflict") {
    return <CannibalizationResolution recommendation={r} />;
  }
  if (r.type === "high_ctr_poor_conversion") {
    return <ConversionResolution recommendation={r} />;
  }
  const pending = r.state === "pending";
  const action = getRecommendationActionDetails(r);

  const valueChart =
    r.currentValue != null && r.proposedValue != null
      ? [
          { name: "Current", value: Number(r.currentValue) },
          { name: "Proposed", value: Number(r.proposedValue) },
        ]
      : null;

  const entities: Array<[string, string | null]> = [
    ["Profile", r.profileId],
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
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
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
            {r.campaign ? (
              <div>
                <dt className="text-xs text-zinc-500">Campaign</dt>
                <dd>
                  <CampaignLink campaign={r.campaign} />
                </dd>
              </div>
            ) : null}
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
        <CardHeader
          title="Action & approval"
          action={
            <Badge tone={action.actionable ? "info" : "warning"}>
              {action.label}
            </Badge>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">
              {action.title}
            </h3>
            <p className="mt-1 text-sm text-zinc-300">{action.summary}</p>
          </div>

          {r.currentValue != null && r.proposedValue != null ? (
            <>
              <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-md border border-zinc-800 px-3 py-2">
                  <p className="text-xs text-zinc-500">
                    {action.currentLabel ?? "Current value"}
                  </p>
                  <p className="text-base font-semibold text-zinc-100">
                    {r.currentValue}
                  </p>
                </div>
                <div className="rounded-md border border-sky-900 bg-sky-950/40 px-3 py-2">
                  <p className="text-xs text-zinc-500">
                    {action.proposedLabel ?? "Suggested value"}
                  </p>
                  <p className="text-base font-semibold text-sky-300">
                    {r.proposedValue}
                  </p>
                </div>
              </div>
              {valueChart ? (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={valueChart}>
                      <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                      <XAxis dataKey="name" stroke="#958ea0" fontSize={12} />
                      <YAxis stroke="#958ea0" fontSize={12} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#1c1c1e",
                          border: "1px solid #3f3f46",
                          fontSize: 12,
                        }}
                      />
                      <Bar dataKey="value" fill="#a078ff" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : null}
            </>
          ) : null}

          <div
            className={`rounded-md border px-3 py-3 text-sm ${
              action.actionable
                ? "border-sky-900 bg-sky-950/30"
                : "border-amber-900 bg-amber-950/20"
            }`}
          >
            <p className="font-medium text-zinc-100">What happens now</p>
            <p className="mt-1 text-zinc-300">{action.approvalEffect}</p>
            <p className="mt-3 font-medium text-zinc-100">Next step</p>
            <p className="mt-1 text-zinc-300">{action.nextStep}</p>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              This will not
            </p>
            <ul className="mt-1.5 grid gap-1 text-sm text-zinc-300 sm:grid-cols-2">
              {action.exclusions.map((exclusion) => (
                <li key={exclusion} className="flex gap-2">
                  <span aria-hidden="true" className="text-zinc-500">
                    —
                  </span>
                  <span>{exclusion}</span>
                </li>
              ))}
            </ul>
          </div>
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
              <dd>
                <time dateTime={r.createdAt}>
                  {formatDateTime(r.createdAt)}
                </time>
              </dd>
            </div>
          </dl>
          {action.actionable ? (
            <p className="mt-3 text-xs text-zinc-500">
              Guardrails: bid changes are clamped per cooldown period, writes
              require a fresh before-state re-check, and this recommendation
              expires when its data goes stale.
            </p>
          ) : (
            <p className="mt-3 text-xs text-zinc-500">
              Safety: this review-only finding has no Amazon write action and
              expires when its source data goes stale.
            </p>
          )}
        </CardBody>
      </Card>

      {pending && action.actionable && (
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

      {pending && !action.actionable && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
          <p className="text-sm text-zinc-400">
            Review-only finding — no change set can be created.
          </p>
          <Button
            variant="secondary"
            disabled={reject.isPending}
            onClick={() =>
              reject.mutate(undefined, {
                onSuccess: () => toast("Finding dismissed"),
                onError: (err) =>
                  toast(`Dismiss failed: ${err.message}`, "error"),
              })
            }
          >
            {reject.isPending ? "Dismissing…" : "Dismiss finding"}
          </Button>
        </div>
      )}
    </div>
  );
}
