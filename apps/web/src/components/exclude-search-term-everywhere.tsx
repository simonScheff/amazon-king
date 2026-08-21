import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type {
  MetricWindow,
  SearchTermCampaignRow,
} from "@amazon-king/contracts";
import { useCreateSearchTermNegatives } from "../api/endpoints";
import { isAsin } from "../lib/asin";
import { formatMoney } from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";
import { useToast } from "./toast";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/**
 * "Exclude everywhere" on the search-term detail: drafts a campaign-level
 * negative for the term in every enabled campaign it runs on in the viewed
 * market — a negative exact keyword, or a negative ASIN product target when
 * the term is an ASIN. One draft change set per campaign, each reviewed and
 * applied in Change center; nothing reaches Amazon until then.
 */
export function ExcludeSearchTermEverywhere({
  term,
  campaigns,
  currency,
  countryCode,
  days,
  bookIds,
}: {
  term: string;
  campaigns: SearchTermCampaignRow[];
  currency: string;
  countryCode: string;
  days: MetricWindow;
  bookIds?: string[];
}) {
  const createNegatives = useCreateSearchTermNegatives(
    term,
    days,
    bookIds,
    countryCode,
  );
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [drafted, setDrafted] = useState(false);

  // Paused and archived campaigns are skipped server-side, so only the
  // enabled ones are offered and sent. Amazon states arrive uppercase
  // ("ENABLED"), so compare case-insensitively.
  const enabled = campaigns.filter(
    (campaign) => campaign.state.trim().toLowerCase() === "enabled",
  );

  if (drafted) {
    return (
      <Link
        to="/changes"
        className="text-xs font-medium text-sky-400 hover:underline"
      >
        Review drafts →
      </Link>
    );
  }

  return (
    <>
      <Button
        size="sm"
        disabled={enabled.length === 0}
        title={
          enabled.length === 0
            ? "No enabled campaigns run this term in this market"
            : undefined
        }
        onClick={() => setConfirmOpen(true)}
      >
        Exclude everywhere
      </Button>
      <Dialog
        open={confirmOpen}
        title="Exclude this search term everywhere?"
        confirmLabel="Draft negatives"
        busy={createNegatives.isPending}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          createNegatives.mutate(
            { campaignIds: enabled.map((campaign) => campaign.campaignId) },
            {
              onSuccess: (result) => {
                setConfirmOpen(false);
                setDrafted(true);
                toast(
                  `${result.changeSetIds.length} draft change sets created`,
                );
              },
              onError: (error) => {
                setConfirmOpen(false);
                toast(`Draft failed: ${error.message}`, "error");
              },
            },
          )
        }
      >
        <p>
          <span className="font-medium text-zinc-100">{term}</span> becomes a
          campaign-level{" "}
          {isAsin(term)
            ? "negative ASIN product target"
            : "negative exact keyword"}{" "}
          on each of these campaigns — {countryNameForCode(countryCode)} (
          {countryCode}) only:
        </p>
        <ul className="mt-2 space-y-1">
          {enabled.map((campaign) => (
            <li
              key={campaign.campaignId}
              className="flex items-baseline justify-between gap-4"
            >
              <span className="truncate">{campaign.name}</span>
              <span className="shrink-0 text-zinc-400">
                {formatMoney(campaign.totals.cost, currency)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          Other markets are not affected. Nothing is sent to Amazon yet — one
          draft per campaign is reviewed and applied in Change center.
        </p>
      </Dialog>
    </>
  );
}
