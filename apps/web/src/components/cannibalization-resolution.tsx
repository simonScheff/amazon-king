import type { Recommendation } from "@amazon-king/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  useCannibalizationResolutionContext,
  useCreateCannibalizationChangeSet,
  useRejectRecommendation,
} from "../api/endpoints";
import { formatDate, formatDateTime, formatMoney } from "../lib/format";
import { ErrorState, Loading } from "./states";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="mt-0.5 h-5 w-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    >
      <path d="M12 3 5 6v5c0 4.6 2.7 8.1 7 10 4.3-1.9 7-5.4 7-10V6l-7-3Z" />
      <path d="m9.5 12 1.7 1.7 3.7-4" strokeLinecap="round" />
    </svg>
  );
}

function evidenceDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

function targetingLabel(value: string | null): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function campaignDetailDays(start: string, end: string): 7 | 14 | 30 | 60 {
  const days = evidenceDays(start, end);
  return days === 7 || days === 14 || days === 60 ? days : 30;
}

export function CannibalizationResolution({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const context = useCannibalizationResolutionContext(recommendation.id);
  const createDraft = useCreateCannibalizationChangeSet(recommendation.id);
  const dismiss = useRejectRecommendation(recommendation.id);
  const toast = useToast();
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [createdChangeSetId, setCreatedChangeSetId] = useState<string | null>(
    null,
  );

  if (context.isPending) return <Loading label="Loading campaign evidence…" />;
  if (context.error) return <ErrorState error={context.error} />;
  if (!context.data) return null;

  const data = context.data;
  const detailDays = campaignDetailDays(
    data.evidenceWindow.start,
    data.evidenceWindow.end,
  );
  const destination = data.campaigns.find(
    (campaign) => campaign.campaignId === destinationId,
  );
  const sourceCampaigns = destination
    ? data.campaigns.filter(
        (campaign) => campaign.campaignId !== destination.campaignId,
      )
    : [];
  const canCreate =
    destination !== undefined &&
    recommendation.state === "pending" &&
    createdChangeSetId === null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5">
      <Link
        to="/recommendations"
        className="w-fit text-sm text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400"
      >
        ← Recommendations
      </Link>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100 md:text-2xl">
          Resolve cannibalization conflict
        </h1>
        <Badge tone="warning">Priority {recommendation.priority}</Badge>
        <Badge tone="info">{recommendation.state}</Badge>
        <span className="ml-auto text-xs text-zinc-500">
          {recommendation.ruleVersion} · {Math.round(data.confidence * 100)}%
          confidence
        </span>
      </header>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
        <div className="grid gap-5 p-5 md:grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr]">
          <div className="flex gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-800 text-zinc-400">
              <SearchIcon />
            </span>
            <div>
              <p className="text-xs text-zinc-500">Shopper term</p>
              <p className="mt-1 text-lg font-semibold text-zinc-100">
                “{data.searchTerm}”
              </p>
              <p className="mt-4 text-xs text-zinc-500">Profile</p>
              <p className="font-mono text-sm text-zinc-300">
                {data.profileId}
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Combined spend</p>
            <p className="mt-1 font-semibold text-zinc-100">
              {formatMoney(data.totalSpend, data.currency)}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Affected campaigns</p>
            <p className="mt-1 font-semibold text-zinc-100">
              {data.campaigns.length} campaigns
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500">Evidence window</p>
            <p className="mt-1 font-semibold text-zinc-100">
              {evidenceDays(data.evidenceWindow.start, data.evidenceWindow.end)}
              {" days"}
            </p>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="min-w-0 space-y-4 rounded-lg border border-zinc-800 bg-zinc-950">
          <section className="p-4 md:p-5">
            <h2 className="text-lg font-semibold text-zinc-100">
              Choose where this search term should win
            </h2>
            <div className="mt-4 overflow-x-auto rounded-md border border-zinc-800">
              <table className="w-full border-collapse text-sm md:min-w-[680px]">
                <thead className="bg-zinc-900/80 text-left text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Campaign</th>
                    <th className="hidden px-4 py-3 font-medium md:table-cell">
                      Intent
                    </th>
                    <th className="hidden px-4 py-3 text-right font-medium md:table-cell">
                      Spend
                    </th>
                    <th className="hidden px-4 py-3 text-right font-medium md:table-cell">
                      Orders
                    </th>
                    <th className="hidden px-4 py-3 text-right font-medium md:table-cell">
                      ACoS
                    </th>
                    <th className="px-4 py-3 font-medium">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {data.campaigns.map((campaign) => {
                    const selected = campaign.campaignId === destinationId;
                    return (
                      <tr
                        key={campaign.campaignId}
                        className={selected ? "bg-sky-950/20" : undefined}
                      >
                        <td className="px-4 py-3">
                          <Link
                            to="/campaigns/$id"
                            params={{ id: campaign.campaignId }}
                            search={{ days: detailDays }}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${campaign.name} in a new tab`}
                            className="group inline-flex items-start gap-2 rounded-sm hover:text-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400"
                          >
                            <span>
                              <span className="block font-medium text-zinc-100 group-hover:text-sky-300">
                                {campaign.name}
                              </span>
                              <span className="block font-mono text-xs text-zinc-500 group-hover:text-sky-400">
                                {campaign.campaignId}
                              </span>
                            </span>
                            <span
                              aria-hidden="true"
                              className="mt-0.5 text-xs text-zinc-600 group-hover:text-sky-400"
                            >
                              ↗
                            </span>
                          </Link>
                          <p className="mt-2 text-xs leading-5 text-zinc-400 md:hidden">
                            {targetingLabel(campaign.targetingType)} ·{" "}
                            {formatMoney(campaign.spend, data.currency)} ·{" "}
                            {campaign.orders} orders · ACoS —
                          </p>
                        </td>
                        <td className="hidden px-4 py-3 text-zinc-300 md:table-cell">
                          {targetingLabel(campaign.targetingType)}
                        </td>
                        <td className="hidden px-4 py-3 text-right text-zinc-300 md:table-cell">
                          {formatMoney(campaign.spend, data.currency)}
                        </td>
                        <td className="hidden px-4 py-3 text-right text-zinc-300 md:table-cell">
                          {campaign.orders}
                        </td>
                        <td className="hidden px-4 py-3 text-right text-zinc-500 md:table-cell">
                          —
                        </td>
                        <td className="px-4 py-3">
                          <label className="inline-flex cursor-pointer items-center gap-2 text-zinc-200 md:whitespace-nowrap">
                            <input
                              type="radio"
                              name="destination-campaign"
                              aria-label={`Choose ${campaign.name} as destination`}
                              value={campaign.campaignId}
                              checked={selected}
                              disabled={createdChangeSetId !== null}
                              onChange={() =>
                                setDestinationId(campaign.campaignId)
                              }
                              className="h-4 w-4 accent-sky-500"
                            />
                            {selected ? "Destination" : "Choose destination"}
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="border-t border-zinc-800 bg-zinc-900/40 px-4 py-2.5 text-xs text-zinc-500">
                ACoS is not present in the version 1 rule evidence, so this
                screen does not automatically suggest a winner.
              </p>
            </div>
          </section>

          <section className="border-t border-zinc-800 p-4 md:p-5">
            <h2 className="text-base font-semibold text-zinc-100">
              Routing strategy
            </h2>
            <div className="mt-3 rounded-md border border-sky-800 bg-sky-950/20 p-4">
              <div className="flex items-start gap-3">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-full border-4 border-sky-400" />
                <div>
                  <p className="font-medium text-zinc-100">
                    Route to one campaign with negative exact
                  </p>
                  <p className="mt-1 text-sm leading-6 text-zinc-300">
                    Add “{data.searchTerm}” as a campaign-level negative exact
                    in every other campaign. Those campaigns keep running for
                    all other shopper queries.
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-4 rounded-md border border-sky-800 px-4 py-3 text-sm text-sky-300">
              No Amazon change happens here. You will preview the draft, then
              separately confirm Apply to Amazon in Change center.
            </div>
          </section>

          <section className="border-t border-zinc-800 p-4 md:p-5">
            <h2 className="text-base font-semibold text-zinc-100">
              Evidence &amp; guardrails
            </h2>
            <dl className="mt-3 divide-y divide-zinc-800 text-sm">
              <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
                <dt className="text-zinc-500">Evidence window</dt>
                <dd>
                  {formatDate(data.evidenceWindow.start)} –{" "}
                  {formatDate(data.evidenceWindow.end)}
                </dd>
              </div>
              <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
                <dt className="text-zinc-500">Data freshness</dt>
                <dd>{formatDateTime(data.dataFreshness)}</dd>
              </div>
              <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
                <dt className="text-zinc-500">Recommendation expiry</dt>
                <dd>{formatDateTime(data.expiresAt)}</dd>
              </div>
              <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
                <dt className="text-zinc-500">Protected-term check</dt>
                <dd>Re-checked before Apply to Amazon</dd>
              </div>
              <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
                <dt className="text-zinc-500">Rollback</dt>
                <dd>
                  Available after verified apply; blocked if Amazon state has
                  changed.
                </dd>
              </div>
            </dl>
          </section>
        </main>

        <aside className="rounded-lg border border-zinc-800 bg-zinc-900/50 xl:sticky xl:top-5">
          <h2 className="border-b border-zinc-800 px-5 py-4 text-base font-semibold text-zinc-100">
            Resolution plan
          </h2>
          <div className="p-5">
            <div className="flex gap-3">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  destination
                    ? "bg-sky-500 text-zinc-950"
                    : "bg-sky-400 text-zinc-950"
                }`}
              >
                {destination ? "✓" : "1"}
              </span>
              <div>
                <p className="font-medium text-zinc-100">
                  Choose a destination
                </p>
                <p className="mt-1 text-sm text-zinc-400">
                  {destination
                    ? `${destination.name} selected by you`
                    : "Select which campaign should win this term."}
                </p>
              </div>
            </div>

            <div className="ml-3 h-9 border-l border-zinc-700" />

            <div className="flex gap-3">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  destination
                    ? "bg-sky-400 text-zinc-950"
                    : "bg-zinc-700 text-zinc-400"
                }`}
              >
                2
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-zinc-100">
                  Review exact Amazon action
                </p>
                <p className="mt-1 text-sm text-zinc-400">
                  Preview the change that will be drafted.
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/50 p-4 text-sm">
              <p className="text-zinc-500">Destination</p>
              <p className="mt-1 font-medium text-zinc-100">
                {destination
                  ? `${destination.name} · no change`
                  : "Not selected"}
              </p>
              <p className="mt-4 text-zinc-500">Amazon action</p>
              {sourceCampaigns.length > 0 ? (
                <ul className="mt-1 space-y-1 font-medium text-zinc-100">
                  {sourceCampaigns.map((campaign) => (
                    <li key={campaign.campaignId}>
                      {campaign.name} · add campaign-level negative exact
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 font-medium text-zinc-100">
                  Other campaign · add negative exact
                </p>
              )}
              <p className="mt-4 text-zinc-500">Search term</p>
              <p className="mt-1 font-medium text-zinc-100">
                {data.searchTerm}
              </p>
              {destination ? (
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-zinc-800 pt-4">
                  <div>
                    <p className="text-zinc-500">Before</p>
                    <p className="mt-1 text-zinc-300">
                      No matching negative exact
                    </p>
                    <p className="mt-1 text-xs italic text-zinc-500">
                      Confirm during preview
                    </p>
                  </div>
                  <div>
                    <p className="text-zinc-500">After</p>
                    <p className="mt-1 text-zinc-300">Negative exact enabled</p>
                  </div>
                </div>
              ) : null}
            </div>

            {createdChangeSetId ? (
              <Link
                to="/changes"
                className="mt-4 flex w-full items-center justify-center rounded-md bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                Review draft {createdChangeSetId} in Change center
              </Link>
            ) : (
              <Button
                variant="primary"
                className="mt-4 w-full py-2.5"
                disabled={!canCreate || createDraft.isPending}
                onClick={() => {
                  if (!destination) return;
                  createDraft.mutate(
                    { destinationCampaignId: destination.campaignId },
                    {
                      onSuccess: (changeSet) => {
                        setCreatedChangeSetId(changeSet.id);
                        toast(`Draft change set ${changeSet.id} created`);
                      },
                      onError: (error) =>
                        toast(`Draft failed: ${error.message}`, "error"),
                    },
                  );
                }}
              >
                {createDraft.isPending
                  ? "Creating draft…"
                  : destination
                    ? "Create draft change set"
                    : "Choose a destination to continue"}
              </Button>
            )}
            <p className="mt-3 text-center text-xs leading-5 text-zinc-500">
              This does not contact Amazon. Apply remains a separate confirmed
              step in Change center.
            </p>
            {recommendation.state === "pending" && !createdChangeSetId ? (
              <button
                type="button"
                disabled={dismiss.isPending}
                className="mt-4 w-full text-center text-sm text-sky-400 hover:underline disabled:text-zinc-600"
                onClick={() =>
                  dismiss.mutate(undefined, {
                    onSuccess: () => toast("Finding dismissed"),
                    onError: (error) =>
                      toast(`Dismiss failed: ${error.message}`, "error"),
                  })
                }
              >
                {dismiss.isPending ? "Dismissing…" : "Keep overlap and dismiss"}
              </button>
            ) : null}
          </div>
          <div className="flex gap-3 border-t border-zinc-800 px-5 py-4 text-sm leading-6 text-zinc-400">
            <ShieldIcon />
            <p>
              Only this search term is affected. No bid, budget, campaign state,
              or other target will change.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
