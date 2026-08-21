import { useState, type FormEvent } from "react";
import type { Book } from "@amazon-king/contracts";
import { isAsin } from "../lib/asin";
import { countryNameForCode } from "../lib/marketplaces";
import { useLinkBookToMarkets } from "../api/endpoints";
import { useToast } from "./toast";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Flag } from "./flag";

export interface LinkBookMarketTarget {
  profileId: string;
  countryCode: string;
}

export function LinkBookToMarketsForm({
  book,
  targets,
  submitLabel,
  onSuccess,
}: {
  book: Pick<Book, "id" | "title" | "asin">;
  targets: LinkBookMarketTarget[];
  submitLabel: string;
  onSuccess?: (book: Book) => void;
}) {
  const link = useLinkBookToMarkets();
  const toast = useToast();
  const [asin, setAsin] = useState(book.asin);
  const trimmed = asin.trim().toUpperCase();
  const asinValid = isAsin(trimmed);
  const countryNames = [
    ...new Set(targets.map((target) => countryNameForCode(target.countryCode))),
  ];
  const asinLabel =
    countryNames.length === 1
      ? `${book.title} ${countryNames[0]} marketplace ASIN`
      : `${book.title} marketplace ASIN`;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!asinValid || targets.length === 0) return;
    link.mutate(
      {
        bookId: book.id,
        profileIds: targets.map((target) => target.profileId),
        asin: trimmed,
      },
      {
        onSuccess: (updated) => {
          toast(`${updated.title} linked to ${countryNames.join(", ")}`);
          onSuccess?.(updated);
        },
        onError: (error) =>
          toast(`Marketplace link failed: ${error.message}`, "error"),
      },
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        {targets.map((target) => (
          <span
            key={target.profileId}
            className="inline-flex items-center gap-1.5"
          >
            <Flag countryCode={target.countryCode} />
            {countryNameForCode(target.countryCode)}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-zinc-500">
          Marketplace ASIN
          <Input
            aria-label={asinLabel}
            value={asin}
            onChange={(event) => setAsin(event.target.value)}
            required
            maxLength={10}
            spellCheck={false}
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={link.isPending || !asinValid}
        >
          {link.isPending ? "Linking…" : submitLabel}
        </Button>
      </div>
      {!asinValid && trimmed.length > 0 ? (
        <p role="alert" className="text-xs text-red-400">
          Expected a 10-character ASIN (B0… or ISBN-10)
        </p>
      ) : null}
    </form>
  );
}
