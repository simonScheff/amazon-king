import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ChangeAction, ChangeSet } from "@amazon-king/contracts";
import {
  useApplyChangeSet,
  useChangeSetPreview,
  useChangeSets,
  useRollbackChangeAction,
} from "../api/endpoints";
import { isReauthError } from "../api/client";
import { ReauthDialog } from "../components/reauth-dialog";
import { useToast } from "../components/toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatDateTime, labelize } from "../lib/format";

const statusTone: Record<
  string,
  "neutral" | "success" | "warning" | "danger" | "info"
> = {
  draft: "neutral",
  previewed: "info",
  applying: "warning",
  applied: "success",
  partially_applied: "warning",
  failed: "danger",
  blocked: "danger",
  verification_failed: "danger",
  rolled_back: "neutral",
  pending: "neutral",
  not_applied: "danger",
};

/**
 * Campaign shown in the actions table: the resolved campaign the action
 * touches, or — for a campaign-creation set — the name of the campaign being
 * created (those actions have no campaignId to join on yet).
 */
function campaignLabel(action: ChangeAction): string | null {
  return (
    action.campaignName ??
    (action.actionType === "create_campaign"
      ? (action.entityName ?? null)
      : null)
  );
}

/** The guarded mutation a REAUTH_REQUIRED failure interrupted. */
type BlockedAction = { kind: "apply" } | { kind: "rollback"; actionId: string };

function ChangeSetDetail({
  changeSet,
  allChangeSets,
  resumeApply = false,
}: {
  changeSet: ChangeSet;
  allChangeSets: ChangeSet[];
  /** Arrived back here from re-auth with this set's apply still pending. */
  resumeApply?: boolean;
}) {
  // Cross-set dependency (e.g. cannibalization negatives locked until their
  // new destination campaign exists on Amazon). The API enforces the same
  // gate; this only explains it and hides the Apply button.
  const dependency = changeSet.dependsOnChangeSetId
    ? allChangeSets.find((cs) => cs.id === changeSet.dependsOnChangeSetId)
    : undefined;
  const dependencyLocked =
    changeSet.dependsOnChangeSetId != null && dependency?.status !== "applied";
  const applyable =
    changeSet.status === "draft" ||
    changeSet.status === "previewed" ||
    changeSet.status === "failed";
  // Only resume into a set that is still waiting to be applied: the apply may
  // well have succeeded before the session went stale.
  const resuming = resumeApply && applyable && !dependencyLocked;

  // Collapsed by default; the preview (actions, guardrails) is fetched lazily
  // on first expand so the page does not fan out one request per set.
  const [expanded, setExpanded] = useState(resuming);
  const preview = useChangeSetPreview(expanded ? changeSet.id : null);
  const apply = useApplyChangeSet(changeSet.id);
  const rollback = useRollbackChangeAction();
  const toast = useToast();
  // Re-auth returns to a fresh page, so the confirmation reopens itself rather
  // than writing to Amazon unprompted — the write still needs a deliberate
  // click.
  const [confirmApply, setConfirmApply] = useState(resuming);
  const [blocked, setBlocked] = useState<BlockedAction | null>(null);

  function runApply() {
    apply.mutate(undefined, {
      onSuccess: () => {
        setConfirmApply(false);
        toast("Change set submitted to Amazon");
      },
      onError: (err) => {
        setConfirmApply(false);
        if (isReauthError(err)) {
          setBlocked({ kind: "apply" });
          return;
        }
        toast(`Apply failed: ${err.message}`, "error");
      },
    });
  }

  function runRollback(actionId: string) {
    rollback.mutate(actionId, {
      onSuccess: () => toast("Rollback requested"),
      onError: (err) => {
        if (isReauthError(err)) {
          setBlocked({ kind: "rollback", actionId });
          return;
        }
        toast(`Rollback failed: ${err.message}`, "error");
      },
    });
  }

  return (
    <Card>
      <CardHeader
        title={
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-2 text-left"
          >
            <span aria-hidden="true" className="w-3 text-zinc-500">
              {expanded ? "▾" : "▸"}
            </span>
            Change set <span className="font-mono text-xs">{changeSet.id}</span>
            <Badge tone={statusTone[changeSet.status] ?? "neutral"}>
              {labelize(changeSet.status)}
            </Badge>
          </button>
        }
        action={
          <span className="text-xs text-zinc-500">
            {formatDateTime(changeSet.createdAt)}
          </span>
        }
      />
      {!expanded ? null : preview.isPending ? (
        <Loading />
      ) : preview.error ? (
        <ErrorState error={preview.error} />
      ) : (
        <CardBody className="flex flex-col gap-3 p-0">
          {preview.data.guardrails.length > 0 && (
            <ul className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500">
              {preview.data.guardrails.map((g) => (
                <li key={g}>Guardrail: {g}</li>
              ))}
            </ul>
          )}
          {preview.data.actions.length === 0 ? (
            <EmptyState>No actions in this change set.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Action</Th>
                  <Th>Campaign</Th>
                  <Th className="text-right">Before</Th>
                  <Th className="text-right">After</Th>
                  <Th>Status</Th>
                  <Th>Amazon request</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {preview.data.actions.map((a) => {
                  const displayStatus =
                    changeSet.status === "failed" && a.status === "pending"
                      ? "not_applied"
                      : a.status;
                  return (
                    <tr key={a.id}>
                      <Td>
                        {labelize(a.actionType)}
                        {(a.searchTerm ?? a.entityName) != null && (
                          <div className="mt-0.5 font-mono text-xs text-zinc-500">
                            {a.searchTerm ?? a.entityName}
                          </div>
                        )}
                      </Td>
                      <Td className="max-w-48 text-sm text-zinc-300">
                        {a.amazonCampaignId && campaignLabel(a) ? (
                          <Link
                            to="/campaigns/$id"
                            params={{ id: a.amazonCampaignId }}
                            className="text-sky-400 hover:underline"
                          >
                            {campaignLabel(a)}
                          </Link>
                        ) : (
                          (campaignLabel(a) ?? "—")
                        )}
                      </Td>
                      <Td className="max-w-72 text-right font-mono text-xs">
                        {a.beforeValue ?? a.beforeDetail ?? "—"}
                      </Td>
                      <Td className="max-w-72 text-right font-mono text-xs">
                        {a.afterValue ?? a.afterDetail ?? "—"}
                      </Td>
                      <Td>
                        <Badge tone={statusTone[displayStatus] ?? "neutral"}>
                          {labelize(displayStatus)}
                        </Badge>
                      </Td>
                      <Td className="font-mono text-xs text-zinc-500">
                        {a.amazonRequestId ?? "—"}
                      </Td>
                      <Td>
                        {a.rollbackAvailable &&
                          (a.status === "applied" ||
                            a.status === "partially_applied") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={rollback.isPending}
                              onClick={() => runRollback(a.id)}
                            >
                              Roll back
                            </Button>
                          )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {changeSet.status === "failed" && (
            <div
              role="alert"
              className="mx-4 rounded-lg border border-red-900/70 bg-red-950/30 px-3 py-2 text-sm text-red-200"
            >
              <p>This attempt did not complete.</p>
              {preview.data.actions.find((a) => a.errorMessage)
                ?.errorMessage && (
                <p className="mt-1 text-xs text-red-300">
                  {
                    preview.data.actions.find((a) => a.errorMessage)
                      ?.errorMessage
                  }
                </p>
              )}
              <p className="mt-1 text-xs text-zinc-400">
                A retry re-reads Amazon first and stops if the live settings no
                longer match this approval.
              </p>
            </div>
          )}
          {(changeSet.status === "draft" ||
            changeSet.status === "previewed" ||
            changeSet.status === "failed") &&
            (dependencyLocked ? (
              <div className="mx-4 mb-3 rounded-md border border-sky-800 bg-sky-950/20 px-3 py-2 text-xs leading-5 text-sky-200">
                Locked until change set{" "}
                <span className="font-mono">
                  {changeSet.dependsOnChangeSetId}
                </span>{" "}
                is applied — the new campaign must exist on Amazon before these
                negatives go live.
              </div>
            ) : (
              <div className="flex justify-end px-4 pb-3">
                <Button variant="primary" onClick={() => setConfirmApply(true)}>
                  {changeSet.status === "failed"
                    ? "Retry apply to Amazon…"
                    : "Apply to Amazon…"}
                </Button>
              </div>
            ))}
        </CardBody>
      )}

      <Dialog
        open={confirmApply}
        title={
          changeSet.status === "failed"
            ? "Retry this change set on Amazon?"
            : "Apply this change set to Amazon?"
        }
        confirmLabel={
          changeSet.status === "failed"
            ? "Yes, retry Amazon write"
            : "Yes, write to Amazon"
        }
        confirmVariant="danger"
        busy={apply.isPending}
        onClose={() => setConfirmApply(false)}
        onConfirm={runApply}
      >
        This performs real write operations against your Amazon Ads account
        (profile <span className="font-mono">{changeSet.profileId}</span>). Each
        action is verified after applying, but spend-affecting changes take
        effect immediately.
      </Dialog>
      <ReauthDialog
        open={blocked !== null}
        // The magic link reloads the page, so the pending apply rides back in
        // the URL; a rollback just returns to the list.
        next={
          blocked?.kind === "apply"
            ? `/changes?apply=${encodeURIComponent(changeSet.id)}`
            : "/changes"
        }
        onClose={() => setBlocked(null)}
        // Signed in without navigating away: the confirmation the user already
        // gave is still live, so finish the action instead of asking again.
        onReauthenticated={() => {
          const pending = blocked;
          setBlocked(null);
          if (pending?.kind === "apply") runApply();
          else if (pending) runRollback(pending.actionId);
        }}
      />
    </Card>
  );
}

export function ChangesPage() {
  const changeSets = useChangeSets();
  const search = useSearch({ strict: false }) as { apply?: string };
  const navigate = useNavigate();
  // The apply the re-auth magic link came back to finish. Captured on mount so
  // stripping it from the URL — which keeps a later reload from reopening the
  // confirmation — does not cancel the resume that is already under way.
  const [resumeApplyId] = useState(search.apply);

  useEffect(() => {
    if (search.apply === undefined) return;
    void navigate({
      to: "/changes",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        apply: undefined,
      }),
      replace: true,
    });
  }, [search.apply, navigate]);

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-bold tracking-tight text-zinc-100">
        Change center
      </h1>
      {changeSets.isPending ? (
        <Loading />
      ) : changeSets.error ? (
        <ErrorState error={changeSets.error} />
      ) : changeSets.data.length === 0 ? (
        <Card>
          <EmptyState>
            No change sets yet. Approve recommendations to create one.
          </EmptyState>
        </Card>
      ) : (
        changeSets.data.map((cs) => (
          <ChangeSetDetail
            key={cs.id}
            changeSet={cs}
            allChangeSets={changeSets.data}
            resumeApply={cs.id === resumeApplyId}
          />
        ))
      )}
    </div>
  );
}
