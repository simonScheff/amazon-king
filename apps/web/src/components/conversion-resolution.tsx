import type {
  ConversionResolutionContext,
  Recommendation,
} from "@amazon-king/contracts";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  useConversionResolutionContext,
  useCreateCampaignNegatives,
  useRejectRecommendation,
  useUpdateCampaignState,
} from "../api/endpoints";
import { isReauthError } from "../api/client";
import { amazonProductUrl } from "../lib/asin";
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
} from "../lib/format";
import { CampaignMaxCpc } from "./campaign-max-cpc";
import { Flag } from "./flag";
import { ReauthDialog } from "./reauth-dialog";
import { ErrorState, Loading } from "./states";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/** How long "remind me later" hides the finding, in days. */
const SNOOZE_DAYS = 30;

type OptionId = "listing" | "negatives" | "max_cpc" | "pause";

const options: Array<{ id: OptionId; title: string; summary: string }> = [
  {
    id: "listing",
    title: "Fix the listing and keep the campaign running",
    summary:
      "Shoppers are interested enough to click, so the ad is working and the page is not. Nothing is sent to Amazon.",
  },
  {
    id: "negatives",
    title: "Block the shopper terms that take clicks and never order",
    summary:
      "Keeps the campaign running for everything else and stops paying for the queries that never convert.",
  },
  {
    id: "max_cpc",
    title: "Cap what one click may cost",
    summary:
      "Lowers every bid above the ceiling so the same traffic costs less while you work on the listing.",
  },
  {
    id: "pause",
    title: "Pause the campaign until the listing is fixed",
    summary:
      "Stops the spend completely. You can enable the campaign again from its page at any time.",
  },
];

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function evidenceDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

export function ConversionResolution({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const context = useConversionResolutionContext(recommendation.id);
  const [option, setOption] = useState<OptionId | null>(null);

  if (context.isPending) return <Loading label="Loading campaign evidence…" />;
  if (context.error) return <ErrorState error={context.error} />;
  if (!context.data) return null;

  const data = context.data;
  const metrics = data.metrics;
  const days = evidenceDays(data.evidenceWindow.start, data.evidenceWindow.end);

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
          Clicked, but not bought
        </h1>
        <Badge tone="warning">Priority {recommendation.priority}</Badge>
        <Badge tone="info">{recommendation.state}</Badge>
        <span className="ml-auto text-xs text-zinc-500">
          {recommendation.ruleVersion} · {Math.round(data.confidence * 100)}%
          confidence
        </span>
      </header>

      <CampaignSummary data={data} days={days} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950">
          <section className="p-4 md:p-5">
            <h2 className="text-lg font-semibold text-zinc-100">
              Choose how to respond
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-400">
              The Ads API cannot change a KDP listing, so there is no single fix
              to approve. These are the responses the app can help with — pick
              one, or combine them.
            </p>

            <div className="mt-4 divide-y divide-zinc-800 rounded-md border border-zinc-800">
              {options.map((item) => (
                <OptionRow
                  key={item.id}
                  title={item.title}
                  summary={item.summary}
                  selected={option === item.id}
                  onSelect={() => setOption(item.id)}
                >
                  {item.id === "listing" ? (
                    <ListingOption
                      data={data}
                      recommendation={recommendation}
                    />
                  ) : item.id === "negatives" ? (
                    <NegativesOption data={data} />
                  ) : item.id === "max_cpc" ? (
                    <MaxCpcOption data={data} />
                  ) : (
                    <PauseOption data={data} />
                  )}
                </OptionRow>
              ))}
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
                <dt className="text-zinc-500">Finding expires</dt>
                <dd>{formatDateTime(data.expiresAt)}</dd>
              </div>
              <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
                <dt className="text-zinc-500">Created</dt>
                <dd>
                  <time dateTime={recommendation.createdAt}>
                    {formatDateTime(recommendation.createdAt)}
                  </time>
                </dd>
              </div>
              <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
                <dt className="text-zinc-500">Before any write</dt>
                <dd>
                  Amazon state is re-read and guardrails re-checked at apply.
                </dd>
              </div>
            </dl>
          </section>
        </main>

        <aside className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 text-sm leading-6 text-zinc-400 xl:sticky xl:top-5">
          <h2 className="text-base font-semibold text-zinc-100">
            What the numbers mean
          </h2>
          <p className="mt-3">
            A click rate of {percent(metrics.ctr)} says the cover, title, and
            price in the search result are doing their job. Of{" "}
            {formatCount(metrics.clicks)} shoppers who then opened the page,{" "}
            {metrics.orders === 0 ? "none" : formatCount(metrics.orders)}{" "}
            bought.
          </p>
          <p className="mt-3">
            More bidding cannot fix that. Every option here either reduces what
            the traffic costs or stops it, while the listing itself is the
            actual fix.
          </p>
          <p className="mt-3 border-t border-zinc-800 pt-3 text-xs">
            Nothing on this screen contacts Amazon on its own. Drafts are
            reviewed in Change center; pausing asks for a confirmation first.
          </p>
        </aside>
      </div>
    </div>
  );
}

function CampaignSummary({
  data,
  days,
}: {
  data: ConversionResolutionContext;
  days: number;
}) {
  const { campaign, metrics } = data;
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <p className="text-xs text-zinc-500">Campaign</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Flag countryCode={data.countryCode} />
            <span>{campaign.name}</span>
          </p>
          <p className="mt-0.5 font-mono text-xs text-zinc-500">
            {campaign.campaignId} · {campaign.state.toLowerCase()}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link
              to="/campaigns/$id"
              params={{ id: campaign.campaignId }}
              search={{ days: 30 }}
              className="text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              Open campaign
            </Link>
            {campaign.amazonConsoleUrl ? (
              <a
                href={campaign.amazonConsoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                Open in Amazon Ads <span aria-hidden="true">↗</span>
              </a>
            ) : null}
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label={`Spend (${days} days)`}
            value={formatMoney(metrics.spend, data.currency)}
          />
          <Stat label="Click rate" value={percent(metrics.ctr)} />
          <Stat label="Conversion rate" value={percent(metrics.cvr)} />
          <Stat
            label="Clicks / orders"
            value={`${formatCount(metrics.clicks)} / ${formatCount(metrics.orders)}`}
          />
        </div>
      </div>
      {data.books.length > 0 ? (
        <div className="flex flex-wrap gap-4 border-t border-zinc-800 px-5 py-4">
          {data.books.map((book) => (
            <div key={`${book.bookId}-${book.asin}`} className="flex gap-3">
              {book.coverImageUrl ? (
                <img
                  src={book.coverImageUrl}
                  alt=""
                  className="h-14 w-10 rounded-sm object-cover"
                />
              ) : null}
              <div>
                <p className="text-xs text-zinc-500">Advertised book</p>
                <p className="font-medium text-zinc-100">{book.title}</p>
                <a
                  href={amazonProductUrl(book.asin, data.countryCode)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                  View the listing shoppers see{" "}
                  <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="border-t border-zinc-800 px-5 py-3 text-xs text-zinc-500">
          No book is mapped to this campaign&apos;s ads, so the listing cannot
          be linked. Map the advertised product in Settings to get it here.
        </p>
      )}
    </section>
  );
}

function OptionRow({
  title,
  summary,
  selected,
  onSelect,
  children,
}: {
  title: string;
  summary: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <div className={selected ? "bg-sky-950/20" : undefined}>
      <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
        <input
          type="radio"
          name="conversion-response"
          checked={selected}
          onChange={onSelect}
          className="mt-1 h-4 w-4 accent-sky-500"
        />
        <span>
          <span className="font-medium text-zinc-100">{title}</span>
          <span className="block text-xs leading-5 text-zinc-400">
            {summary}
          </span>
        </span>
      </label>
      {selected ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}

const listingChecks: Array<{ title: string; detail: string }> = [
  {
    title: "Cover at thumbnail size",
    detail:
      "It won the click in the search results; check it still says the right genre on the product page next to the competition.",
  },
  {
    title: "Price against comparable titles",
    detail:
      "Open two or three books that rank for the same terms. A price above them needs the page to justify it.",
  },
  {
    title: "Title, subtitle, and the first two lines of the blurb",
    detail:
      "Shoppers decide here. The promise has to match what the ad's keywords asked for.",
  },
  {
    title: "Look Inside",
    detail:
      "Front matter that delays the opening pages, or formatting that breaks on a phone, loses the sale after the click.",
  },
  {
    title: "Reviews",
    detail:
      "A low count or rating next to well-reviewed competitors explains a click that does not convert.",
  },
  {
    title: "Targeting fit",
    detail:
      "Check the campaign's shopper terms. Traffic looking for something adjacent will click and leave no matter what the page says.",
  },
];

function ListingOption({
  data,
  recommendation,
}: {
  data: ConversionResolutionContext;
  recommendation: Recommendation;
}) {
  const reject = useRejectRecommendation(recommendation.id);
  const toast = useToast();
  const pending = recommendation.state === "pending";

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-4">
      <ol className="space-y-3 text-sm">
        {listingChecks.map((check, index) => (
          <li key={check.title} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-300">
              {index + 1}
            </span>
            <span>
              <span className="font-medium text-zinc-100">{check.title}</span>
              <span className="block leading-6 text-zinc-400">
                {check.detail}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {data.books.length > 0 ? (
        <p className="mt-4 text-sm">
          {data.books.map((book) => (
            <a
              key={`${book.bookId}-${book.asin}`}
              href={amazonProductUrl(book.asin, data.countryCode)}
              target="_blank"
              rel="noopener noreferrer"
              className="mr-4 text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              Open “{book.title}” on Amazon <span aria-hidden="true">↗</span>
            </a>
          ))}
        </p>
      ) : null}
      {pending ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
          <Button
            variant="primary"
            disabled={reject.isPending}
            onClick={() =>
              reject.mutate(
                { snoozeDays: SNOOZE_DAYS },
                {
                  onSuccess: () =>
                    toast(
                      `Hidden for ${SNOOZE_DAYS} days — it returns if the numbers do not improve`,
                    ),
                  onError: (error) =>
                    toast(`Could not snooze: ${error.message}`, "error"),
                },
              )
            }
          >
            {reject.isPending
              ? "Saving…"
              : `I am fixing the listing — remind me in ${SNOOZE_DAYS} days`}
          </Button>
          <Button
            disabled={reject.isPending}
            onClick={() =>
              reject.mutate(undefined, {
                onSuccess: () => toast("Finding dismissed"),
                onError: (error) =>
                  toast(`Dismiss failed: ${error.message}`, "error"),
              })
            }
          >
            Dismiss this finding
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NegativesOption({ data }: { data: ConversionResolutionContext }) {
  const createNegatives = useCreateCampaignNegatives(data.campaign.campaignId);
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);

  if (data.wastefulTerms.length === 0) {
    return (
      <p className="rounded-md border border-zinc-800 bg-zinc-950/50 px-4 py-3 text-sm text-zinc-400">
        Nothing left to block. Every zero-order term in this window is already a
        negative on this campaign, or none of them took a click.
      </p>
    );
  }

  function toggle(term: string) {
    setSelected((current) =>
      current.includes(term)
        ? current.filter((item) => item !== term)
        : [...current, term],
    );
  }

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/50">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="text-left text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium">Block</th>
              <th className="px-4 py-2 font-medium">Shopper term</th>
              <th className="px-4 py-2 text-right font-medium">Clicks</th>
              <th className="px-4 py-2 text-right font-medium">Spend</th>
              <th className="px-4 py-2 text-right font-medium">Orders</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {data.wastefulTerms.map((term) => (
              <tr key={term.searchTerm}>
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Block ${term.searchTerm}`}
                    checked={selected.includes(term.searchTerm)}
                    disabled={draftId !== null}
                    onChange={() => toggle(term.searchTerm)}
                    className="h-4 w-4 accent-sky-500"
                  />
                </td>
                <td className="px-4 py-2 text-zinc-200">{term.searchTerm}</td>
                <td className="px-4 py-2 text-right text-zinc-300">
                  {formatCount(term.clicks)}
                </td>
                <td className="px-4 py-2 text-right text-zinc-300">
                  {formatMoney(term.spend, data.currency)}
                </td>
                <td className="px-4 py-2 text-right text-zinc-500">
                  {term.orders}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-4 py-3">
        {draftId ? (
          <Link
            to="/changes"
            className="text-sm font-medium text-sky-400 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            Review draft {draftId} in Change center →
          </Link>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={selected.length === 0 || createNegatives.isPending}
              onClick={() =>
                createNegatives.mutate(
                  { searchTerms: selected },
                  {
                    onSuccess: (changeSet) => {
                      setDraftId(changeSet.id);
                      toast(`Draft change set ${changeSet.id} created`);
                    },
                    onError: (error) =>
                      toast(`Draft failed: ${error.message}`, "error"),
                  },
                )
              }
            >
              {createNegatives.isPending
                ? "Creating draft…"
                : selected.length === 0
                  ? "Select the terms to block"
                  : `Draft ${selected.length} negative${selected.length === 1 ? "" : "s"}`}
            </Button>
            <p className="text-xs leading-5 text-zinc-500">
              Each term becomes a campaign-level negative exact — a negative
              ASIN target when the term is an ASIN. Nothing is sent to Amazon
              until you apply the draft.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function MaxCpcOption({ data }: { data: ConversionResolutionContext }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/50">
      <p className="border-b border-zinc-800 px-4 py-3 text-sm leading-6 text-zinc-400">
        Clicks currently cost{" "}
        <span className="font-medium text-zinc-200">
          {formatMoney(data.metrics.averageCpc, data.currency)}
        </span>{" "}
        on average here.{" "}
        {data.metrics.suggestedMaxCpc
          ? `${formatMoney(data.metrics.suggestedMaxCpc, data.currency)} is offered as a
             starting ceiling — it is a cut below what you pay now, not a
             break-even bid, which needs a conversion rate this finding does
             not have.`
          : "Set the ceiling you are willing to pay while the listing is fixed."}
      </p>
      <CampaignMaxCpc
        campaignId={data.campaign.campaignId}
        suggestedMaxCpc={data.metrics.suggestedMaxCpc}
      />
    </div>
  );
}

function PauseOption({ data }: { data: ConversionResolutionContext }) {
  const updateState = useUpdateCampaignState(data.campaign.campaignId);
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const paused = data.campaign.state.toLowerCase() === "paused";

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/50 px-4 py-3">
      {paused ? (
        <p className="text-sm text-zinc-400">
          This campaign is already paused, so it is not spending. Enable it
          again from the campaign page once the listing is updated.
        </p>
      ) : (
        <>
          <p className="text-sm leading-6 text-zinc-400">
            Pausing stops all spend on this campaign immediately. Its history,
            keywords, and bids stay as they are, and enabling it again is one
            click on the campaign page.
          </p>
          {!data.campaign.writeEnabled ? (
            <p className="mt-3 rounded-md border border-amber-900/70 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
              This profile is read-only. Enable writes in Settings before
              pausing.
            </p>
          ) : null}
          <Button
            variant="primary"
            className="mt-3"
            disabled={!data.campaign.writeEnabled || updateState.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            {updateState.isPending ? "Pausing…" : "Pause this campaign"}
          </Button>
        </>
      )}
      <Dialog
        open={confirmOpen}
        title="Pause this campaign?"
        confirmLabel="Pause campaign"
        busy={updateState.isPending}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          updateState.mutate(
            { state: "paused" },
            {
              onSuccess: () => {
                setConfirmOpen(false);
                toast("Campaign paused");
              },
              onError: (error) => {
                setConfirmOpen(false);
                if (isReauthError(error)) setReauthOpen(true);
                else toast(`Pause failed: ${error.message}`, "error");
              },
            },
          )
        }
      >
        <p>
          {data.campaign.name} stops serving as soon as Amazon accepts the
          change. This is applied straight away, not drafted for review.
        </p>
      </Dialog>
      <ReauthDialog open={reauthOpen} onClose={() => setReauthOpen(false)} />
    </div>
  );
}
