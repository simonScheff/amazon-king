import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useRemoveNegative } from "../api/endpoints";
import { useToast } from "./toast";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/**
 * Re-includes an excluded shopper term or product by drafting the removal of
 * the synced negative that blocks it. Nothing reaches Amazon until the draft
 * is applied in Change center.
 */
export function ReincludeNegative({
  campaignId,
  kind,
  negativeId,
  label,
}: {
  campaignId: string;
  kind: "keyword" | "target";
  negativeId: string;
  /** The term or ASIN shown in the confirm dialog. */
  label: string;
}) {
  const removeNegative = useRemoveNegative(campaignId);
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);

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
        Re-include
      </Button>
      <Dialog
        open={confirmOpen}
        title="Re-include this exclusion?"
        confirmLabel="Draft removal"
        busy={removeNegative.isPending}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          removeNegative.mutate(
            { kind, negativeId },
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
          The{" "}
          {kind === "target"
            ? "negative ASIN product target"
            : "negative exact keyword"}{" "}
          blocking <span className="font-medium text-zinc-100">{label}</span> is
          removed from this campaign, so it can trigger ads here again.
        </p>
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          Nothing is sent to Amazon yet — the draft is reviewed and applied in
          Change center.
        </p>
      </Dialog>
    </>
  );
}
