import { useState, type FormEvent } from "react";
import {
  bookFormatSchema,
  goalModeSchema,
  type AdvertisedBookCandidate,
  type AmazonProfile,
  type Book,
  type BookEconomics,
  type BookFormat,
  type GoalMode,
} from "@amazon-king/contracts";
import {
  useAuditEvents,
  useBooks,
  useEnqueueSync,
  useMapAdvertisedBook,
  useProfiles,
  useSaveBookCover,
  useSaveBookEconomics,
  useUnmappedAdvertisedProducts,
  useUpdateProfile,
} from "../api/endpoints";
import { useToast } from "../components/toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Input, Select } from "../components/ui/input";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { Flag } from "../components/flag";
import { formatDate, formatDateTime, labelize } from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";

interface AdvertisedBookGroup {
  asin: string;
  candidates: AdvertisedBookCandidate[];
}

function groupAdvertisedBooks(
  candidates: AdvertisedBookCandidate[],
): AdvertisedBookGroup[] {
  const groups = new Map<string, AdvertisedBookCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.asin);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(candidate.asin, [candidate]);
    }
  }
  return [...groups].map(([asin, groupedCandidates]) => ({
    asin,
    candidates: groupedCandidates,
  }));
}

const BOOK_FORMAT_LABELS: Record<BookFormat, string> = {
  paperback: "Paperback",
  hardcover: "Hardcover",
  kindle: "Kindle eBook",
  other: "Other",
};

function AdvertisedBookMappingForm({ asin, candidates }: AdvertisedBookGroup) {
  const mapBook = useMapAdvertisedBook();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<BookFormat>("paperback");
  const [coverUrl, setCoverUrl] = useState("");
  const marketplaces = candidates
    .map((candidate) => `${candidate.countryCode} (${candidate.currencyCode})`)
    .join(" · ");
  const adCount = candidates.reduce(
    (total, candidate) => total + candidate.adCount,
    0,
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedCoverUrl = coverUrl.trim();
    mapBook.mutate(
      {
        profileIds: candidates.map((candidate) => candidate.profileId),
        asin,
        title,
        format,
        ...(trimmedCoverUrl ? { coverImageUrl: trimmedCoverUrl } : {}),
      },
      {
        onSuccess: (book) => toast(`${book.title} added to your book catalog`),
        onError: (error) =>
          toast(`Book mapping failed: ${error.message}`, "error"),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 px-4 py-4">
      <div>
        <p className="font-mono text-sm font-medium text-zinc-200">{asin}</p>
        <p className="mt-0.5 text-xs text-zinc-500">
          {marketplaces} · {adCount} {adCount === 1 ? "ad" : "ads"}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(10rem,1fr)_auto] md:items-end">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Book title
          <Input
            required
            maxLength={500}
            placeholder="Enter the KDP book title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Format
          <Select
            value={format}
            onChange={(event) =>
              setFormat(bookFormatSchema.parse(event.target.value))
            }
          >
            {bookFormatSchema.options.map((option) => (
              <option key={option} value={option}>
                {BOOK_FORMAT_LABELS[option]}
              </option>
            ))}
          </Select>
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={mapBook.isPending || title.trim().length === 0}
        >
          {mapBook.isPending ? "Adding…" : "Add book"}
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        Cover image URL (optional)
        <Input
          aria-label="Cover image URL"
          type="url"
          maxLength={2048}
          placeholder="https://…"
          value={coverUrl}
          onChange={(event) => setCoverUrl(event.target.value)}
        />
      </label>
    </form>
  );
}

function BookCoverForm({ book }: { book: Book }) {
  const save = useSaveBookCover(book.id);
  const toast = useToast();
  const [url, setUrl] = useState(book.coverImageUrl ?? "");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = url.trim();
    save.mutate(
      { coverImageUrl: trimmed === "" ? null : trimmed },
      {
        onSuccess: () =>
          toast(trimmed === "" ? "Cover image removed" : "Cover image saved"),
        onError: (error) =>
          toast(`Cover save failed: ${error.message}`, "error"),
      },
    );
  }

  return (
    <form
      aria-label={`${book.title} cover image`}
      onSubmit={onSubmit}
      className="mb-3 flex flex-wrap items-end gap-3"
    >
      {book.coverImageUrl ? (
        <img
          src={book.coverImageUrl}
          alt={`${book.title} cover`}
          className="h-16 w-12 rounded border border-zinc-800 object-cover"
        />
      ) : null}
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-zinc-500">
        Cover image URL (optional)
        <Input
          aria-label={`${book.title} cover image URL`}
          type="url"
          maxLength={2048}
          placeholder="https://…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <Button type="submit" variant="primary" disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save cover"}
      </Button>
    </form>
  );
}

function inputDecimal(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : value;
}

function BookEconomicsProfileForm({
  book,
  profile,
  economics,
}: {
  book: Book;
  profile: AmazonProfile;
  economics?: BookEconomics;
}) {
  const save = useSaveBookEconomics(book.id);
  const toast = useToast();
  const [listPrice, setListPrice] = useState(() =>
    inputDecimal(economics?.listPrice),
  );
  const [royalty, setRoyalty] = useState(() =>
    inputDecimal(economics?.estimatedRoyaltyPerSale),
  );
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [targetAcosPct, setTargetAcosPct] = useState(() =>
    economics?.targetAcos == null
      ? ""
      : inputDecimal(String(economics.targetAcos * 100)),
  );
  const [goalMode, setGoalMode] = useState<GoalMode>(
    economics?.goalMode ?? "balanced",
  );
  const [notes, setNotes] = useState(economics?.notes ?? "");
  const countryName = countryNameForCode(profile.countryCode);
  const saved = economics !== undefined;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const pct = targetAcosPct.trim();
    save.mutate(
      {
        profileId: profile.profileId,
        effectiveFrom,
        currency: profile.currencyCode,
        listPrice,
        estimatedRoyaltyPerSale: royalty,
        targetAcos: pct === "" ? null : Number(pct) / 100,
        goalMode,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: () => toast(`${countryName} economics saved`),
        onError: (err) => toast(`Save failed: ${err.message}`, "error"),
      },
    );
  }

  return (
    <form
      aria-label={`${countryName} book economics`}
      onSubmit={onSubmit}
      className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-zinc-100">
            <span className="mr-2" aria-hidden="true">
              <Flag countryCode={profile.countryCode} />
            </span>
            {countryName}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {profile.currencyCode} · Marketplace-specific price and royalty
          </p>
        </div>
        <Badge tone={saved ? "success" : "warning"}>
          {saved
            ? `Saved ${formatDate(economics.effectiveFrom)}`
            : "Needs setup"}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          List price ({profile.currencyCode})
          <Input
            aria-label={`${countryName} list price`}
            inputMode="decimal"
            required
            placeholder="9.99"
            value={listPrice}
            onChange={(e) => setListPrice(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Net royalty per sale ({profile.currencyCode})
          <Input
            aria-label={`${countryName} net royalty per sale`}
            inputMode="decimal"
            required
            placeholder="2.04"
            value={royalty}
            onChange={(e) => setRoyalty(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Effective from
          <Input
            aria-label={`${countryName} economics effective from`}
            type="date"
            required
            max={new Date().toISOString().slice(0, 10)}
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Target ACoS (%)
          <Input
            aria-label={`${countryName} target ACoS`}
            inputMode="decimal"
            placeholder="e.g. 25"
            value={targetAcosPct}
            onChange={(e) => setTargetAcosPct(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Goal mode
          <Select
            aria-label={`${countryName} goal mode`}
            value={goalMode}
            onChange={(e) => setGoalMode(goalModeSchema.parse(e.target.value))}
          >
            {goalModeSchema.options.map((g) => (
              <option key={g} value={g}>
                {labelize(g)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500 sm:col-span-2">
          Notes (optional)
          <Input
            aria-label={`${countryName} notes`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-xs text-zinc-600">
          Use the first date these economics were valid. Historical profit is
          available only for data on or after that date.
        </p>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending
            ? "Saving…"
            : `${saved ? "Update" : "Save"} ${countryName}`}
        </Button>
      </div>
    </form>
  );
}

function BookEconomicsForms({
  book,
  profiles,
}: {
  book: Book;
  profiles: AmazonProfile[];
}) {
  const linkedProfiles = profiles
    .filter((profile) => book.profileIds.includes(profile.profileId))
    .sort((a, b) => {
      if (a.countryCode === "US") return -1;
      if (b.countryCode === "US") return 1;
      return countryNameForCode(a.countryCode).localeCompare(
        countryNameForCode(b.countryCode),
      );
    });
  const economicsByProfile = new Map(
    book.economics.map((economics) => [economics.profileId, economics]),
  );
  const configuredCount = linkedProfiles.filter((profile) =>
    economicsByProfile.has(profile.profileId),
  ).length;

  return (
    <article className="px-4 py-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">{book.title}</h3>
          <p className="mt-1 text-xs text-zinc-500">
            <span className="font-mono">{book.asin}</span> ·{" "}
            {labelize(book.format)}
          </p>
        </div>
        <Badge
          tone={
            configuredCount === linkedProfiles.length ? "success" : "warning"
          }
        >
          {configuredCount} of {linkedProfiles.length} countries configured
        </Badge>
      </div>
      <BookCoverForm book={book} />
      {linkedProfiles.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No profile is linked to this book.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {linkedProfiles.map((profile) => (
            <BookEconomicsProfileForm
              key={profile.profileId}
              book={book}
              profile={profile}
              economics={economicsByProfile.get(profile.profileId)}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function SettingsPage() {
  const books = useBooks();
  const unmappedProducts = useUnmappedAdvertisedProducts();
  const profiles = useProfiles();
  const audit = useAuditEvents();
  const toast = useToast();
  const advertisedBookGroups = groupAdvertisedBooks(
    unmappedProducts.data ?? [],
  );

  return (
    <div className="flex w-full min-w-0 max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-bold tracking-tight text-zinc-100">
        Settings & health
      </h1>

      <Card>
        <CardHeader title="Profiles: sync & write access" />
        {profiles.isPending ? (
          <Loading />
        ) : profiles.error ? (
          <ErrorState error={profiles.error} />
        ) : profiles.data.length === 0 ? (
          <EmptyState>No profiles connected.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Profile</Th>
                <Th>Region</Th>
                <Th>Currency</Th>
                <Th>Read (sync)</Th>
                <Th>Writes</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {profiles.data.map((p) => (
                <ProfileSettingsRow key={p.profileId} profile={p} />
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Book economics" />
        {books.isPending ? (
          <Loading label="Loading book economics…" />
        ) : books.error ? (
          <ErrorState error={books.error} />
        ) : books.data.length > 0 ? (
          <div className="border-b border-zinc-800">
            <div className="bg-emerald-950/15 px-4 py-3">
              <p className="text-sm font-medium text-emerald-200">Your books</p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                Enter the list price and net KDP royalty separately for every
                country where the book is advertised.
              </p>
            </div>
            <div className="divide-y divide-zinc-800">
              {books.data.map((book) => (
                <BookEconomicsForms
                  key={book.id}
                  book={book}
                  profiles={profiles.data ?? []}
                />
              ))}
            </div>
          </div>
        ) : null}

        {unmappedProducts.isPending ? (
          <Loading label="Looking for new advertised ASINs…" />
        ) : unmappedProducts.error ? (
          <ErrorState error={unmappedProducts.error} />
        ) : advertisedBookGroups.length > 0 ? (
          <div>
            <div className="bg-sky-950/20 px-4 py-3">
              <p className="text-sm font-medium text-sky-200">
                New advertised ASINs to identify
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                Amazon Ads supplied these ASINs without a KDP title or format.
                Identify each one to add it to Your books.
              </p>
            </div>
            <div className="divide-y divide-zinc-800">
              {advertisedBookGroups.map((group) => (
                <AdvertisedBookMappingForm key={group.asin} {...group} />
              ))}
            </div>
          </div>
        ) : (books.data ?? []).length === 0 ? (
          <EmptyState>
            No advertised books found yet. Run Sync now for a profile that has
            Sponsored Products ads.
          </EmptyState>
        ) : (
          <p className="px-4 py-3 text-xs text-zinc-500">
            All advertised ASINs have been identified.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Audit events" />
        {audit.isPending ? (
          <Loading />
        ) : audit.error ? (
          <ErrorState error={audit.error} />
        ) : audit.data.length === 0 ? (
          <EmptyState>No audit events recorded yet.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Actor</Th>
                <Th>Event</Th>
                <Th>Entity</Th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-xs text-zinc-500">
                    {formatDateTime(e.createdAt)}
                  </Td>
                  <Td className="text-xs">{e.actor}</Td>
                  <Td className="text-xs">{e.event}</Td>
                  <Td className="font-mono text-xs text-zinc-500">
                    {e.entityType}
                    {e.entityId ? `:${e.entityId}` : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function ProfileSettingsRow({ profile }: { profile: AmazonProfile }) {
  const update = useUpdateProfile(profile.profileId);
  const sync = useEnqueueSync(profile.profileId);
  const toast = useToast();
  return (
    <tr>
      <Td className="font-mono text-xs">{profile.profileId}</Td>
      <Td>{profile.region}</Td>
      <Td>{profile.currencyCode}</Td>
      <Td>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-sky-500"
            checked={profile.enabled}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate(
                { enabled: e.target.checked },
                {
                  onError: (err) =>
                    toast(`Update failed: ${err.message}`, "error"),
                },
              )
            }
          />
          {profile.enabled ? "On" : "Off"}
        </label>
      </Td>
      <Td>
        <Badge tone="neutral">read-only</Badge>
        <WriteToggle profile={profile} />
      </Td>
      <Td>
        <Button
          size="sm"
          disabled={sync.isPending || !profile.enabled}
          onClick={() =>
            sync.mutate(undefined, {
              onSuccess: (run) =>
                toast(`Sync queued (${run.kind}, ${run.status})`),
              onError: (err) => toast(`Sync failed: ${err.message}`, "error"),
            })
          }
        >
          {sync.isPending ? "Queuing…" : "Sync now"}
        </Button>
      </Td>
    </tr>
  );
}

/**
 * Per-profile write toggle. AmazonProfile has no writeEnabled field in the
 * contracts yet, so the toggle is only rendered when the API returns one.
 */
function WriteToggle({ profile }: { profile: AmazonProfile }) {
  const update = useUpdateProfile(profile.profileId);
  const toast = useToast();
  const writeEnabled = (profile as { writeEnabled?: boolean }).writeEnabled;
  if (writeEnabled === undefined) return null;
  return (
    <label className="ml-2 inline-flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 accent-red-500"
        checked={writeEnabled}
        disabled={update.isPending}
        onChange={(e) =>
          update.mutate(
            { writeEnabled: e.target.checked },
            {
              onError: (err) => toast(`Update failed: ${err.message}`, "error"),
            },
          )
        }
      />
      {writeEnabled ? "write-enabled" : "read-only"}
    </label>
  );
}
