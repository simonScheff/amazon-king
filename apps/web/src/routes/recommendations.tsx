import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  recommendationStateSchema,
  recommendationTypeSchema,
  type Recommendation,
  type RecommendationState,
  type RecommendationType,
} from "@amazon-king/contracts";
import { useRecommendations, useRejectRecommendation } from "../api/endpoints";
import { useToast } from "../components/toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Select } from "../components/ui/input";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatDate, formatDateTime, labelize } from "../lib/format";

const stateTone: Record<
  string,
  "neutral" | "success" | "warning" | "danger" | "info"
> = {
  pending: "warning",
  approved: "info",
  rejected: "neutral",
  expired: "neutral",
  applied: "success",
  protected: "info",
};

function Row({ rec }: { rec: Recommendation }) {
  const reject = useRejectRecommendation(rec.id);
  const toast = useToast();
  return (
    <tr>
      <Td>
        <Badge tone={rec.priority <= 2 ? "warning" : "neutral"}>
          P{rec.priority}
        </Badge>
      </Td>
      <Td>
        <Link
          to="/recommendations/$id"
          params={{ id: rec.id }}
          className="text-sky-400 hover:underline"
        >
          {labelize(rec.type)}
        </Link>
        <p className="mt-0.5 line-clamp-2 max-w-md text-xs text-zinc-500">
          {rec.rationale}
        </p>
      </Td>
      <Td>
        <Badge tone={stateTone[rec.state] ?? "neutral"}>{rec.state}</Badge>
      </Td>
      <Td className="text-xs text-zinc-400">
        {formatDate(rec.evidenceWindow.start)} –{" "}
        {formatDate(rec.evidenceWindow.end)}
        <br />
        <span title="Data freshness">
          data as of {formatDateTime(rec.dataFreshness)}
        </span>
      </Td>
      <Td>{Math.round(rec.confidence * 100)}%</Td>
      <Td>
        {rec.state === "pending" && (
          <Button
            size="sm"
            variant="ghost"
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
        )}
      </Td>
    </tr>
  );
}

export function RecommendationsPage() {
  const search = useSearch({ strict: false }) as {
    type?: RecommendationType;
    state?: RecommendationState;
  };
  const navigate = useNavigate();
  const recs = useRecommendations({ type: search.type, state: search.state });

  function setFilter(patch: Partial<typeof search>) {
    void navigate({
      to: "/recommendations",
      search: { ...search, ...patch },
      replace: true,
    });
  }

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          Recommendations
        </h1>
        <div className="ml-auto flex gap-2">
          <Select
            aria-label="Filter by type"
            value={search.type ?? ""}
            onChange={(e) =>
              setFilter({
                type: (e.target.value || undefined) as
                  RecommendationType | undefined,
              })
            }
          >
            <option value="">All types</option>
            {recommendationTypeSchema.options.map((t) => (
              <option key={t} value={t}>
                {labelize(t)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by state"
            value={search.state ?? ""}
            onChange={(e) =>
              setFilter({
                state: (e.target.value || undefined) as
                  RecommendationState | undefined,
              })
            }
          >
            <option value="">All states</option>
            {recommendationStateSchema.options.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        {recs.isPending ? (
          <Loading />
        ) : recs.error ? (
          <ErrorState error={recs.error} />
        ) : recs.data.length === 0 ? (
          <EmptyState>
            No recommendations match these filters. Recommendations appear after
            the optimizer runs on synced data.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Priority</Th>
                <Th>Finding</Th>
                <Th>State</Th>
                <Th>Evidence</Th>
                <Th>Confidence</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {[...recs.data]
                .sort((a, b) => a.priority - b.priority)
                .map((r) => (
                  <Row key={r.id} rec={r} />
                ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
