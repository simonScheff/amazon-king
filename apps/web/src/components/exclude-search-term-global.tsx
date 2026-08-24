import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  useCreateSearchTermExclusion,
  useDeleteSearchTermExclusion,
} from "../api/endpoints";
import { isAsin } from "../lib/asin";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/**
 * "Exclude everywhere" on the search-terms list and detail pages: records the
 * term in the persistent workspace exclusion list and drafts a campaign-level
 * negative — a negative exact keyword, or a negative ASIN product target when
 * the term is an ASIN — for every campaign that served the term recently, in
 * every market. The worker's enforcement pass drafts the same negative once a
 * future campaign starts serving the term. All drafts stay approval-gated in
 * Change center; nothing reaches Amazon until the owner applies them there.
 *
 * Terms already on the exclusion list render an "Excluded everywhere" badge
 * that doubles as the undo: clicking it asks for confirmation and removes the
 * term from the list (negatives already on Amazon stay — re-including those
 * is the per-campaign flow). The list is also managed under Settings →
 * Profiles.
 */
export function ExcludeSearchTermGlobal({
  term,
  excluded,
}: {
  term: string;
  excluded: boolean;
}) {
  const createExclusion = useCreateSearchTermExclusion(term);
  const removeExclusion = useDeleteSearchTermExclusion();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [drafted, setDrafted] = useState(false);

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

  if (excluded) {
    return (
      <>
        <button
          type="button"
          title="On the workspace exclusion list — blocked wherever it serves, in every market. A future campaign that starts serving it gets an approval-gated draft. Click to remove it from the list."
          onClick={() => setRemoveOpen(true)}
          className="transition-opacity hover:opacity-75"
        >
          <Badge tone="neutral">Excluded everywhere</Badge>
        </button>
        <Dialog
          open={removeOpen}
          title={`Remove “${term}” from the exclusion list?`}
          confirmLabel="Remove from list"
          confirmVariant="danger"
          busy={removeExclusion.isPending}
          onClose={() => setRemoveOpen(false)}
          onConfirm={() =>
            removeExclusion.mutate(term, {
              onSuccess: () => {
                setRemoveOpen(false);
                toast(`“${term}” removed from the exclusion list`);
              },
              onError: (error) => {
                setRemoveOpen(false);
                toast(`Remove failed: ${error.message}`, "error");
              },
            })
          }
        >
          <p>
            Future campaigns that start serving{" "}
            <span className="font-medium text-zinc-100">{term}</span> will no
            longer get an automatic exclusion draft.
          </p>
          <p className="mt-2 text-xs leading-5 text-zinc-500">
            Negatives already applied on Amazon are not removed — re-including
            those stays the per-campaign flow on the campaign page.
          </p>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setConfirmOpen(true)}>
        Exclude everywhere
      </Button>
      <Dialog
        open={confirmOpen}
        title="Exclude this search term everywhere?"
        confirmLabel="Draft negatives"
        busy={createExclusion.isPending}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          createExclusion.mutate(undefined, {
            onSuccess: (result) => {
              setConfirmOpen(false);
              setDrafted(true);
              toast(
                result.changeSets.length > 0
                  ? `${result.changeSets.length} draft change sets created`
                  : "Term excluded — no campaign served it yet, so there is nothing to draft",
              );
            },
            onError: (error) => {
              setConfirmOpen(false);
              toast(`Draft failed: ${error.message}`, "error");
            },
          })
        }
      >
        <p>
          <span className="font-medium text-zinc-100">{term}</span> becomes a
          campaign-level{" "}
          {isAsin(term)
            ? "negative ASIN product target"
            : "negative exact keyword"}{" "}
          in every campaign that ran this search term, in{" "}
          <strong>all markets</strong> — and it is added to the workspace
          exclusion list, so if a future campaign starts serving the term, a
          draft change set is prepared automatically for your approval.
        </p>
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          Nothing is sent to Amazon yet: one draft change set per market is
          created, and you review and apply them in Change center.
        </p>
      </Dialog>
    </>
  );
}
