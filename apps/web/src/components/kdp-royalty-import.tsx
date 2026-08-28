import { useRef, useState, type ChangeEvent } from "react";
import type {
  KdpRoyaltyImport,
  KdpRoyaltySkipReason,
} from "@amazon-king/contracts";
import {
  useApplyKdpRoyaltyImport,
  useCreateKdpRoyaltyImport,
} from "../api/endpoints";
import { parseKdpRoyaltyReport } from "../lib/kdp-report";
import { formatDate } from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, Td, Th } from "./ui/table";
import { Flag } from "./flag";

/**
 * KDP royalty import (docs/kdp-royalty-import-plan.md): the owner uploads a
 * Royalties Estimator workbook, reviews the derived royalty-per-copy
 * suggestions, and applies the selected ones into book economics.
 */

const SKIP_REASON_LABELS: Record<KdpRoyaltySkipReason, string> = {
  unknown_marketplace: "Unknown marketplace",
  no_ads_profile: "No ads profile connected",
  asin_not_linked: "ASIN not linked to any book",
  currency_mismatch: "Currency doesn't match the profile",
  no_standard_rows: "No standard-rate sales in the period",
};

export function KdpImportButton({
  onImported,
}: {
  onImported: (batch: KdpRoyaltyImport) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const create = useCreateKdpRoyaltyImport();
  const toast = useToast();

  async function onFile(file: File) {
    try {
      const buffer = await file.arrayBuffer();
      const report = await parseKdpRoyaltyReport(buffer, file.name);
      create.mutate(report, {
        onSuccess: (batch) => {
          if (batch.alreadyExisted) {
            toast(
              "This file was already imported — showing the existing batch",
            );
          }
          onImported(batch);
        },
        onError: (error) => toast(`Import failed: ${error.message}`, "error"),
      });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not read that file",
        "error",
      );
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void onFile(file);
    // Allow re-picking the same file.
    event.target.value = "";
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        aria-label="KDP Royalties Estimator workbook"
        onChange={onChange}
      />
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={create.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {create.isPending ? "Importing…" : "Import from KDP report"}
      </Button>
    </>
  );
}

function selectionKey(bookId: string, profileId: string): string {
  return `${bookId}${profileId}`;
}

export function KdpImportReview({
  batch,
  onClose,
}: {
  batch: KdpRoyaltyImport;
  onClose: () => void;
}) {
  const apply = useApplyKdpRoyaltyImport();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        batch.suggestions
          .filter(
            (suggestion) =>
              !suggestion.lowEvidence &&
              suggestion.currentRoyaltyPerSale !== null,
          )
          .map((suggestion) =>
            selectionKey(suggestion.bookId, suggestion.profileId),
          ),
      ),
  );
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const alreadyApplied = batch.appliedAt !== null;

  function toggle(key: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function onApply() {
    const selections = batch.suggestions
      .filter((suggestion) =>
        selected.has(selectionKey(suggestion.bookId, suggestion.profileId)),
      )
      .map((suggestion) => ({
        bookId: suggestion.bookId,
        profileId: suggestion.profileId,
      }));
    apply.mutate(
      { id: batch.id, selections, effectiveFrom },
      {
        onSuccess: (result) => {
          toast(
            result.skipped.length > 0
              ? `Applied ${result.applied}, skipped ${result.skipped.length}`
              : `Applied ${result.applied} royalty ${result.applied === 1 ? "update" : "updates"}`,
          );
          onClose();
        },
        onError: (error) => toast(`Apply failed: ${error.message}`, "error"),
      },
    );
  }

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/40">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <p className="text-sm font-semibold text-zinc-100">
          KDP royalty import — {formatDate(batch.periodStart)} to{" "}
          {formatDate(batch.periodEnd)}
        </p>
        <span className="inline-flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-mono">{batch.fileName}</span>· {batch.rowCount}{" "}
          transactions · {batch.suggestions.length} suggestions
        </span>
      </div>
      <p className="px-4 pt-2 text-xs leading-5 text-zinc-500">
        Suggestions use standard-rate sales only. Expanded-distribution sales
        (40%/50% royalty rows) can't come from an ad click, so they're excluded
        from the royalty math and shown as context. Applying keeps list price,
        target ACoS, and goal — only royalty per sale changes.
      </p>
      {alreadyApplied ? (
        <p className="px-4 pt-2 text-xs text-emerald-400">
          This batch was already applied on {formatDate(batch.appliedAt)}.
        </p>
      ) : null}

      <div className="px-4 py-3">
        <Table>
          <thead>
            <tr>
              <Th>
                <span className="sr-only">Select</span>
              </Th>
              <Th>Book</Th>
              <Th>Market</Th>
              <Th>Royalty per sale</Th>
              <Th>Standard sales</Th>
              <Th>Expanded dist.</Th>
            </tr>
          </thead>
          <tbody>
            {batch.suggestions.map((suggestion) => {
              const key = selectionKey(suggestion.bookId, suggestion.profileId);
              const hasEconomics = suggestion.currentRoyaltyPerSale !== null;
              const current = Number(suggestion.currentRoyaltyPerSale);
              const suggested = Number(suggestion.suggestedRoyaltyPerSale);
              const delta = hasEconomics ? suggested - current : null;
              return (
                <tr key={key}>
                  <Td className="align-middle">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-sky-600"
                      aria-label={`Select ${suggestion.title} ${suggestion.countryCode}`}
                      checked={selected.has(key)}
                      disabled={!hasEconomics || alreadyApplied}
                      onChange={() => toggle(key)}
                    />
                  </Td>
                  <Td className="max-w-64 align-middle">
                    <span className="block truncate text-sm text-zinc-200">
                      {suggestion.title}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap align-middle">
                    <span className="inline-flex items-center gap-2 text-sm text-zinc-200">
                      <Flag countryCode={suggestion.countryCode} />
                      {countryNameForCode(suggestion.countryCode)}
                      <span className="text-xs text-zinc-500">
                        {suggestion.currency}
                      </span>
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap align-middle">
                    {hasEconomics ? (
                      <span className="text-sm">
                        {suggestion.currentRoyaltyPerSale}
                        <span className="px-1.5 text-zinc-600">→</span>
                        <span className="font-semibold text-zinc-100">
                          {suggestion.suggestedRoyaltyPerSale}
                        </span>{" "}
                        <span
                          className={`text-xs font-semibold ${
                            delta !== null && delta < 0
                              ? "text-amber-300"
                              : "text-emerald-400"
                          }`}
                        >
                          {delta !== null && delta !== 0
                            ? `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`
                            : "±0.00"}
                        </span>
                      </span>
                    ) : (
                      <Badge tone="neutral">No economics yet</Badge>
                    )}
                    {suggestion.lowEvidence ? (
                      <Badge tone="warning" className="ml-2">
                        Low evidence
                      </Badge>
                    ) : null}
                    {suggestion.deviationWarning ? (
                      <Badge tone="warning" className="ml-2">
                        &gt;15% change
                      </Badge>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm">
                    {suggestion.standardUnits}{" "}
                    {suggestion.standardUnits === 1 ? "copy" : "copies"}
                  </Td>
                  <Td className="whitespace-nowrap align-middle text-sm">
                    {suggestion.expandedUnits > 0 ? (
                      <Badge tone="warning">
                        {suggestion.expandedUnits} excluded
                      </Badge>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>

        {batch.skipped.length > 0 ? (
          <div className="mt-3 rounded-md border border-dashed border-zinc-700 px-3 py-2.5 text-xs text-zinc-500">
            <p className="font-medium text-zinc-300">
              {batch.skipped.length} row{" "}
              {batch.skipped.length === 1 ? "group" : "groups"} skipped:
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {batch.skipped.map((entry, index) => (
                <li key={`${entry.marketplace}-${entry.asin}-${index}`}>
                  <span className="font-mono">{entry.asin || "—"}</span> ·{" "}
                  {entry.marketplace} — {SKIP_REASON_LABELS[entry.reason]}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3">
        <p className="max-w-md text-xs leading-5 text-zinc-600">
          Applying writes each selected market's economics through the usual
          save path with a full audit trail. Nothing changes until you apply.
        </p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            Effective from
            <Input
              type="date"
              aria-label="Effective from"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="w-36 px-2 py-1.5"
            />
          </label>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={apply.isPending || selected.size === 0 || alreadyApplied}
            onClick={onApply}
          >
            {apply.isPending ? "Applying…" : `Apply ${selected.size} selected`}
          </Button>
        </div>
      </div>
    </div>
  );
}
