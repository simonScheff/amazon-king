import { useState } from "react";
import type { ChangeSet } from "@amazon-king/contracts";
import {
  useApplyChangeSet,
  useChangeSetPreview,
  useChangeSets,
  useRollbackChangeAction,
} from "../api/endpoints";
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
};

function ChangeSetDetail({ changeSet }: { changeSet: ChangeSet }) {
  const preview = useChangeSetPreview(changeSet.id);
  const apply = useApplyChangeSet(changeSet.id);
  const rollback = useRollbackChangeAction();
  const toast = useToast();
  const [confirmApply, setConfirmApply] = useState(false);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Change set <span className="font-mono text-xs">{changeSet.id}</span>
            <Badge tone={statusTone[changeSet.status] ?? "neutral"}>
              {labelize(changeSet.status)}
            </Badge>
          </span>
        }
        action={
          <span className="text-xs text-zinc-500">
            {formatDateTime(changeSet.createdAt)}
          </span>
        }
      />
      {preview.isPending ? (
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
                {preview.data.actions.map((a) => (
                  <tr key={a.id}>
                    <Td>{labelize(a.actionType)}</Td>
                    <Td className="text-right font-mono text-xs">
                      {a.beforeValue ?? "—"}
                    </Td>
                    <Td className="text-right font-mono text-xs">
                      {a.afterValue ?? "—"}
                    </Td>
                    <Td>
                      <Badge tone={statusTone[a.status] ?? "neutral"}>
                        {labelize(a.status)}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-xs text-zinc-500">
                      {a.amazonRequestId ?? "—"}
                    </Td>
                    <Td>
                      {(a.status === "applied" ||
                        a.status === "partially_applied") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={rollback.isPending}
                          onClick={() =>
                            rollback.mutate(a.id, {
                              onSuccess: () => toast("Rollback requested"),
                              onError: (err) =>
                                toast(
                                  `Rollback failed: ${err.message}`,
                                  "error",
                                ),
                            })
                          }
                        >
                          Roll back
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {(changeSet.status === "draft" ||
            changeSet.status === "previewed") && (
            <div className="flex justify-end px-4 pb-3">
              <Button variant="primary" onClick={() => setConfirmApply(true)}>
                Apply to Amazon…
              </Button>
            </div>
          )}
        </CardBody>
      )}

      <Dialog
        open={confirmApply}
        title="Apply this change set to Amazon?"
        confirmLabel="Yes, write to Amazon"
        confirmVariant="danger"
        busy={apply.isPending}
        onClose={() => setConfirmApply(false)}
        onConfirm={() =>
          apply.mutate(undefined, {
            onSuccess: () => {
              setConfirmApply(false);
              toast("Change set submitted to Amazon");
            },
            onError: (err) => {
              setConfirmApply(false);
              toast(`Apply failed: ${err.message}`, "error");
            },
          })
        }
      >
        This performs real write operations against your Amazon Ads account
        (profile <span className="font-mono">{changeSet.profileId}</span>). Each
        action is verified after applying, but spend-affecting changes take
        effect immediately.
      </Dialog>
    </Card>
  );
}

export function ChangesPage() {
  const changeSets = useChangeSets();

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-lg font-semibold text-zinc-100">Change center</h1>
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
          <ChangeSetDetail key={cs.id} changeSet={cs} />
        ))
      )}
    </div>
  );
}
