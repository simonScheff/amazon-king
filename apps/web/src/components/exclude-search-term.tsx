import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useCreateCampaignNegatives } from "../api/endpoints";
import { isAsin } from "../lib/asin";
import { useToast } from "./toast";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/**
 * Drafts a campaign-level negative for one shopper term straight from the
 * campaign's search-term table: a negative exact keyword, or a negative ASIN
 * product target when the term is an ASIN. Nothing reaches Amazon until the
 * draft is applied in Change center.
 */
export function ExcludeSearchTerm({
  campaignId,
  term,
  alreadyExcluded,
}: {
  campaignId: string;
  term: string;
  /** A synced enabled negative already blocks this exact term. */
  alreadyExcluded?: boolean;
}) {
  const createNegatives = useCreateCampaignNegatives(campaignId);
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);

  if (alreadyExcluded) {
    return <span className="text-xs text-zinc-500">Excluded</span>;
  }
  if (draftId) {
    return (
      <Link
        to="/changes"
        className="text-xs font-medium text-sky-400 hover:underline"
      >
        Review draft {draftId} →
      </Link>
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setConfirmOpen(true)}>
        Exclude
      </Button>
      <Dialog
        open={confirmOpen}
        title="Exclude this search term?"
        confirmLabel="Draft negative"
        busy={createNegatives.isPending}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          createNegatives.mutate(
            { searchTerms: [term] },
            {
              onSuccess: (changeSet) => {
                setConfirmOpen(false);
                setDraftId(changeSet.id);
                toast(`Draft change set ${changeSet.id} created`);
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
          on this campaign, so it stops triggering ads here.
        </p>
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          Nothing is sent to Amazon yet — the draft is reviewed and applied in
          Change center.
        </p>
      </Dialog>
    </>
  );
}
