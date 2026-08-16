import { useEffect, useState, type FormEvent } from "react";
import {
  useApplyChangeSet,
  useCampaignMaxCpc,
  useChangeSetPreview,
  useSetCampaignMaxCpc,
} from "../api/endpoints";
import { isReauthError } from "../api/client";
import { formatDateTime, formatMoney } from "../lib/format";
import { ReauthDialog } from "./reauth-dialog";
import { EmptyState, ErrorState, Loading } from "./states";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

function actionLabel(action: {
  actionType: string;
  entityName?: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  afterDetail?: string | null;
}) {
  const name = action.entityName ?? "Amazon setting";
  if (action.beforeValue !== null && action.afterValue !== null) {
    return `${name}: ${action.beforeValue} → ${action.afterValue}`;
  }
  return `${name}: ${action.afterDetail ?? action.actionType}`;
}

export function CampaignMaxCpc({ campaignId }: { campaignId: string }) {
  const controls = useCampaignMaxCpc(campaignId);
  const setMaxCpc = useSetCampaignMaxCpc(campaignId);
  const [value, setValue] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const preview = useChangeSetPreview(draftId);
  const apply = useApplyChangeSet(draftId ?? "");

  useEffect(() => {
    if (controls.data?.maxCpc && value === "") {
      setValue(controls.data.maxCpc);
    }
  }, [controls.data?.maxCpc, value]);

  if (controls.isPending) return <Loading />;
  if (controls.error) return <ErrorState error={controls.error} />;
  if (!controls.data)
    return <EmptyState>Bid controls are unavailable.</EmptyState>;

  const data = controls.data;
  const activeAdjustments = data.adjustments.filter(
    (item) => item.percentage > 0,
  );
  const statusTone =
    data.status === "covered"
      ? "success"
      : data.status === "pending"
        ? "warning"
        : "neutral";
  const statusLabel = {
    not_configured: "Not configured",
    pending: "Pending approval",
    covered: "Ceiling covered",
    drifted: "Needs attention",
    unsupported: "Not supported",
  }[data.status];

  function submit(event: FormEvent) {
    event.preventDefault();
    setMaxCpc.mutate(
      { maxCpc: value },
      {
        onSuccess: (result) => {
          // A fingerprint can return the same failed set. Do not present the
          // previous mutation error as though this review just called Amazon.
          apply.reset();
          setDraftId(result.changeSet.id);
        },
        onError: (err) => {
          if (isReauthError(err)) setReauthOpen(true);
        },
      },
    );
  }

  function applyDraft() {
    apply.mutate(undefined, {
      onSuccess: () => {
        apply.reset();
        setDraftId(null);
        void controls.refetch();
      },
      onError: (err) => {
        if (isReauthError(err)) setReauthOpen(true);
      },
    });
  }

  return (
    <div className="p-4 sm:p-5">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-100">
                  One maximum CPC
                </h2>
                <Badge tone={statusTone}>{statusLabel}</Badge>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-400">
                Set the most you are willing to pay for a click. The app lowers
                higher base bids, uses dynamic bids down only, removes bid
                boosts, and disables active Amazon bid rules.
              </p>
              {data.status === "pending" ? (
                <a
                  href="/changes"
                  className="mt-2 inline-flex text-sm font-medium text-sky-400 hover:underline"
                >
                  Review pending change in Change center →
                </a>
              ) : null}
            </div>
          </div>

          <form onSubmit={submit} className="mt-5 max-w-md">
            <label
              htmlFor="campaign-max-cpc"
              className="text-sm font-medium text-zinc-200"
            >
              Maximum price per click
            </label>
            <div className="mt-2 flex items-stretch gap-2">
              <div className="flex min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 focus-within:outline focus-within:outline-2 focus-within:outline-sky-500">
                <span className="flex items-center border-r border-zinc-800 px-3 text-xs font-semibold text-zinc-500">
                  {data.currency}
                </span>
                <Input
                  id="campaign-max-cpc"
                  aria-describedby="campaign-max-cpc-help"
                  className="min-w-0 flex-1 border-0 bg-transparent text-base focus-visible:outline-none"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  required
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="0.75"
                />
              </div>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  !data.writeEnabled ||
                  setMaxCpc.isPending ||
                  Number(value) <= 0
                }
              >
                {setMaxCpc.isPending ? "Checking…" : "Review ceiling"}
              </Button>
            </div>
            <p
              id="campaign-max-cpc-help"
              className="mt-2 text-xs leading-5 text-zinc-500"
            >
              Bids already below this amount stay unchanged. Every change is
              shown for approval before anything is sent to Amazon.
            </p>
          </form>

          {!data.writeEnabled ? (
            <p className="mt-3 rounded-md border border-amber-900/70 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
              This profile is read-only. Enable writes in Settings before
              applying a ceiling.
            </p>
          ) : null}
          {setMaxCpc.error && !isReauthError(setMaxCpc.error) ? (
            <p role="alert" className="mt-3 text-sm text-red-300">
              {errorMessage(setMaxCpc.error)}
            </p>
          ) : null}

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <CoverageItem
              label="Base bids"
              value={
                data.maxCpc
                  ? `${data.counts.bidsAboveCeiling} above ceiling`
                  : `${data.counts.adGroups + data.counts.explicitTargetBids} checked`
              }
              detail="Ad-group defaults, keywords, and product targets"
              covered={
                data.maxCpc !== null && data.counts.bidsAboveCeiling === 0
              }
            />
            <CoverageItem
              label="Dynamic bidding"
              value={
                data.strategy === "LEGACY_FOR_SALES"
                  ? "Down only"
                  : (data.strategy ?? "Unknown")
              }
              detail="Amazon cannot dynamically increase the base bid"
              covered={data.strategy === "LEGACY_FOR_SALES"}
            />
            <CoverageItem
              label="Placement & audience boosts"
              value={
                activeAdjustments.length === 0
                  ? "No active boosts"
                  : `${activeAdjustments.length} active`
              }
              detail="Top of search, product page, and audience adjustments"
              covered={activeAdjustments.length === 0}
            />
            <CoverageItem
              label="Amazon bid rules"
              value={
                data.activeBidRules.length === 0
                  ? "No active rules"
                  : `${data.activeBidRules.length} active`
              }
              detail="Schedule and optimization rules that can alter bids"
              covered={data.activeBidRules.length === 0}
            />
          </div>
        </div>

        <aside className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Current exposure
          </p>
          <p className="mt-3 text-2xl font-semibold tabular-nums text-zinc-100">
            {data.currentMaxAdjustedBid === null
              ? "Not bounded"
              : formatMoney(data.currentMaxAdjustedBid, data.currency)}
          </p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {data.currentMaxAdjustedBid === null
              ? "Amazon can still increase a bid through a strategy, boost, or rule."
              : "Highest known effective CPC from the current controls."}
          </p>
          <dl className="mt-5 space-y-3 border-t border-zinc-800 pt-4 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Highest base bid</dt>
              <dd className="tabular-nums text-zinc-200">
                {data.currentMaxBaseBid === null
                  ? "—"
                  : formatMoney(data.currentMaxBaseBid, data.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Last checked</dt>
              <dd className="text-right text-zinc-300">
                {formatDateTime(data.sourceReadAt)}
              </dd>
            </div>
          </dl>
        </aside>
      </div>

      <Dialog
        open={draftId !== null}
        title="Review Max CPC coverage"
        confirmLabel={`Apply ${preview.data?.actions.length ?? ""} changes`}
        busy={apply.isPending}
        onClose={() => {
          apply.reset();
          setDraftId(null);
        }}
        onConfirm={
          preview.data && preview.data.guardrails.length === 0
            ? applyDraft
            : undefined
        }
      >
        {preview.isPending ? <Loading /> : null}
        {preview.error ? <ErrorState error={preview.error} /> : null}
        {preview.data ? (
          <div>
            <p>
              This will enforce a {data.currency} {value} ceiling across the
              campaign. No lower bid will be raised.
            </p>
            {preview.data.guardrails.length > 0 ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-red-300">
                {preview.data.guardrails.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : preview.data.actions.length === 0 ? (
              <p className="mt-3 rounded-md bg-emerald-950/40 px-3 py-2 text-emerald-300">
                Amazon already matches this ceiling. Apply to save the policy.
              </p>
            ) : (
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto rounded-md bg-zinc-950 p-3 text-xs">
                {preview.data.actions.slice(0, 12).map((action) => (
                  <li key={action.id} className="text-zinc-300">
                    {actionLabel(action)}
                  </li>
                ))}
                {preview.data.actions.length > 12 ? (
                  <li className="text-zinc-500">
                    + {preview.data.actions.length - 12} more changes
                  </li>
                ) : null}
              </ul>
            )}
            {apply.error && !isReauthError(apply.error) ? (
              <p role="alert" className="mt-3 text-red-300">
                {errorMessage(apply.error)}
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>
      <ReauthDialog open={reauthOpen} onClose={() => setReauthOpen(false)} />
    </div>
  );
}

function CoverageItem({
  label,
  value,
  detail,
  covered,
}: {
  label: string;
  value: string;
  detail: string;
  covered: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-zinc-200">{label}</p>
        <span
          className={covered ? "text-emerald-400" : "text-amber-300"}
          aria-label={covered ? "Covered" : "Needs change"}
        >
          {covered ? "✓" : "●"}
        </span>
      </div>
      <p className="mt-2 text-sm font-semibold text-zinc-100">{value}</p>
      <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>
    </div>
  );
}
