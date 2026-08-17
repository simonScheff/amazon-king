import { useState } from "react";
import { useRenameCampaign, useUpdateCampaignState } from "../api/endpoints";
import { isReauthError } from "../api/client";
import { ReauthDialog } from "./reauth-dialog";
import { useToast } from "./toast";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * One-click guarded campaign controls on the campaign detail page: pause /
 * enable and rename. Each action drafts and applies a `campaign_update`
 * change set server-side (recent-auth enforced — a stale session opens the
 * re-auth dialog and returns here after the magic link).
 */
export function CampaignControls({
  campaignId,
  name,
  state,
}: {
  campaignId: string;
  name: string;
  state: string;
}) {
  const toast = useToast();
  const updateState = useUpdateCampaignState(campaignId);
  const rename = useRenameCampaign(campaignId);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);

  const paused = state.toLowerCase() === "paused";
  const pending = updateState.isPending || rename.isPending;
  const mutationError = updateState.error ?? rename.error;
  const errorMessage =
    mutationError && !isReauthError(mutationError)
      ? mutationError instanceof Error
        ? mutationError.message
        : "Update failed"
      : null;

  function onMutationError(err: unknown) {
    if (isReauthError(err)) setReauthOpen(true);
  }

  function toggleState() {
    updateState.mutate(
      { state: paused ? "enabled" : "paused" },
      {
        onSuccess: () => toast(paused ? "Campaign enabled" : "Campaign paused"),
        onError: onMutationError,
      },
    );
  }

  function saveName() {
    const next = draftName.trim();
    if (next === "" || next === name) {
      setEditing(false);
      setDraftName(name);
      return;
    }
    rename.mutate(
      { name: next },
      {
        onSuccess: () => {
          setEditing(false);
          toast("Campaign renamed");
        },
        onError: onMutationError,
      },
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {editing ? (
        <span className="inline-flex items-center gap-2">
          <Input
            aria-label="Campaign name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") {
                setEditing(false);
                setDraftName(name);
              }
            }}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={saveName}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setDraftName(name);
            }}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Rename campaign"
          onClick={() => {
            setDraftName(name);
            setEditing(true);
          }}
        >
          Rename
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={toggleState}
      >
        {updateState.isPending
          ? paused
            ? "Enabling…"
            : "Pausing…"
          : paused
            ? "Enable campaign"
            : "Pause campaign"}
      </Button>
      {errorMessage ? (
        <span role="alert" className="text-xs text-red-400">
          {errorMessage}
        </span>
      ) : null}
      <ReauthDialog open={reauthOpen} onClose={() => setReauthOpen(false)} />
    </span>
  );
}
