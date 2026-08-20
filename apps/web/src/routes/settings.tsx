import { useState, type FormEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
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
import { Card, CardHeader } from "../components/ui/card";
import { Input, Select } from "../components/ui/input";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { Flag } from "../components/flag";
import { BookCoverThumb } from "../components/book-covers";
import { formatDate, formatDateTime, labelize } from "../lib/format";
import { countryNameForCode } from "../lib/marketplaces";
import { LinkBookToMarketsForm } from "../components/link-book-to-markets";

export const SETTINGS_TABS = ["profiles", "books", "asins", "audit"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABELS: Record<SettingsTab, string> = {
  profiles: "Profiles & sync",
  books: "Books & economics",
  asins: "New ASINs",
  audit: "Audit log",
};

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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

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
      className="flex flex-wrap items-end gap-3"
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

const ECONOMICS_COLUMN_COUNT = 6;

/**
 * One country's economics as a single editable table row. The rarely changed
 * fields (effective-from date, notes) live behind a per-row Details toggle so
 * the common case — price, royalty, target ACoS — fits on one line.
 */
function BookEconomicsRow({
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const countryName = countryNameForCode(profile.countryCode);
  const saved = economics !== undefined;
  const canSave =
    listPrice.trim() !== "" && royalty.trim() !== "" && effectiveFrom !== "";

  function onSave() {
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
    <>
      <tr className={saved ? undefined : "bg-amber-950/10"}>
        <Td className="whitespace-nowrap align-middle">
          <span className="inline-flex items-center gap-2 text-sm text-zinc-200">
            <Flag countryCode={profile.countryCode} />
            {countryName}
            <span className="text-xs text-zinc-500">
              {profile.currencyCode}
            </span>
          </span>
        </Td>
        <Td className="align-middle">
          <Input
            aria-label={`${countryName} list price`}
            inputMode="decimal"
            placeholder="9.99"
            value={listPrice}
            onChange={(e) => setListPrice(e.target.value)}
            className={`w-20 px-2 py-1.5 ${saved ? "" : "border-amber-700/50"}`}
          />
        </Td>
        <Td className="align-middle">
          <Input
            aria-label={`${countryName} net royalty per sale`}
            inputMode="decimal"
            placeholder="2.04"
            value={royalty}
            onChange={(e) => setRoyalty(e.target.value)}
            className={`w-20 px-2 py-1.5 ${saved ? "" : "border-amber-700/50"}`}
          />
        </Td>
        <Td className="align-middle">
          <Input
            aria-label={`${countryName} target ACoS`}
            inputMode="decimal"
            placeholder="e.g. 25"
            value={targetAcosPct}
            onChange={(e) => setTargetAcosPct(e.target.value)}
            className="w-[4.5rem] px-2 py-1.5"
          />
        </Td>
        <Td className="align-middle">
          <Select
            aria-label={`${countryName} goal mode`}
            value={goalMode}
            onChange={(e) => setGoalMode(goalModeSchema.parse(e.target.value))}
            className="px-2 py-1.5"
          >
            {goalModeSchema.options.map((g) => (
              <option key={g} value={g}>
                {labelize(g)}
              </option>
            ))}
          </Select>
        </Td>
        <Td className="whitespace-nowrap align-middle">
          <span className="flex flex-col items-end gap-1.5">
            {saved ? (
              <span className="text-xs text-emerald-400">
                Saved {formatDate(economics.effectiveFrom)}
              </span>
            ) : (
              <span className="text-xs text-amber-300">Needs setup</span>
            )}
            <span className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={detailsOpen}
                aria-label={`${countryName} economics details`}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                Details
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                aria-label={`${saved ? "Update" : "Save"} ${countryName}`}
                disabled={save.isPending || !canSave}
                onClick={onSave}
              >
                {save.isPending ? "Saving…" : saved ? "Update" : "Save"}
              </Button>
            </span>
          </span>
        </Td>
      </tr>
      {detailsOpen ? (
        <tr>
          <Td colSpan={ECONOMICS_COLUMN_COUNT} className="bg-zinc-950/40">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                Effective from
                <Input
                  aria-label={`${countryName} economics effective from`}
                  type="date"
                  max={new Date().toISOString().slice(0, 10)}
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                Notes (optional)
                <Input
                  aria-label={`${countryName} notes`}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            </div>
            <p className="mt-2 max-w-xl text-xs text-zinc-600">
              Use the first date these economics were valid. Historical profit
              is available only for data on or after that date.
            </p>
          </Td>
        </tr>
      ) : null}
    </>
  );
}

function BookSettingsCard({
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
  const unlinkedEnabledProfiles = profiles
    .filter(
      (profile) =>
        profile.enabled && !book.profileIds.includes(profile.profileId),
    )
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
  const asinByProfile = new Map(
    (book.marketplaceAsins ?? []).map((entry) => [entry.profileId, entry.asin]),
  );
  const complete =
    linkedProfiles.length > 0 && configuredCount === linkedProfiles.length;
  // Books that still need setup open on their own; finished ones collapse.
  const [open, setOpen] = useState(!complete);

  return (
    <article>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-zinc-800/40"
      >
        <BookCoverThumb
          title={book.title}
          coverImageUrl={book.coverImageUrl}
          decorative
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-zinc-100">
            {book.title}
          </span>
          <span className="mt-0.5 block text-xs text-zinc-500">
            <span className="font-mono">{book.asin}</span> ·{" "}
            {labelize(book.format)}
          </span>
        </span>
        <Badge tone={complete ? "success" : "warning"}>
          {configuredCount} of {linkedProfiles.length} countries configured
        </Badge>
        <Chevron open={open} />
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-zinc-800/60 px-4 py-4">
          <BookCoverForm book={book} />
          {linkedProfiles.length > 0 ? (
            <ul className="flex flex-col gap-1.5 text-xs text-zinc-400">
              {linkedProfiles.map((profile) => (
                <li
                  key={profile.profileId}
                  className="inline-flex items-center gap-2"
                >
                  <Flag countryCode={profile.countryCode} />
                  {countryNameForCode(profile.countryCode)}
                  <span className="font-mono text-zinc-500">
                    {asinByProfile.get(profile.profileId) ?? book.asin}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">
              No profile is linked to this book.
            </p>
          )}
          {unlinkedEnabledProfiles.length > 0 ? (
            <details className="rounded-md border border-zinc-800 bg-zinc-950/40">
              <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium text-zinc-400 hover:text-zinc-200">
                Link another market ({unlinkedEnabledProfiles.length})
              </summary>
              <div className="flex flex-col gap-2 border-t border-zinc-800/60 px-3 py-3">
                <p className="text-xs leading-5 text-zinc-500">
                  Link a market where this paperback is already for sale.
                  amazon-king does not publish the listing — it only records the
                  ASIN for a product ad. Amazon rejects apply if the ASIN is not
                  yours there.
                </p>
                {unlinkedEnabledProfiles.map((profile) => (
                  <LinkBookToMarketsForm
                    key={profile.profileId}
                    book={book}
                    targets={[
                      {
                        profileId: profile.profileId,
                        countryCode: profile.countryCode,
                      },
                    ]}
                    submitLabel={`Add to ${countryNameForCode(profile.countryCode)}`}
                  />
                ))}
              </div>
            </details>
          ) : null}
          {linkedProfiles.length === 0 ? null : (
            <Table>
              <thead>
                <tr>
                  <Th>Country</Th>
                  <Th>List price</Th>
                  <Th>Net royalty</Th>
                  <Th>Target ACoS %</Th>
                  <Th>Goal</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {linkedProfiles.map((profile) => (
                  <BookEconomicsRow
                    key={profile.profileId}
                    book={book}
                    profile={profile}
                    economics={economicsByProfile.get(profile.profileId)}
                  />
                ))}
              </tbody>
            </Table>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ProfilesCard() {
  const profiles = useProfiles();
  return (
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
  );
}

function BooksCard() {
  const books = useBooks();
  const profiles = useProfiles();
  return (
    <Card>
      <CardHeader title="Books & economics" />
      {books.isPending ? (
        <Loading label="Loading book economics…" />
      ) : books.error ? (
        <ErrorState error={books.error} />
      ) : books.data.length === 0 ? (
        <EmptyState>
          No advertised books found yet. Run Sync now for a profile that has
          Sponsored Products ads.
        </EmptyState>
      ) : (
        <>
          <div className="border-b border-zinc-800 bg-emerald-950/15 px-4 py-3">
            <p className="text-sm font-medium text-emerald-200">Your books</p>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              Enter the list price and net KDP royalty separately for every
              country where the book is advertised.
            </p>
          </div>
          <div className="divide-y divide-zinc-800">
            {books.data.map((book) => (
              <BookSettingsCard
                key={book.id}
                book={book}
                profiles={profiles.data ?? []}
              />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function NewAsinsCard() {
  const unmappedProducts = useUnmappedAdvertisedProducts();
  const advertisedBookGroups = groupAdvertisedBooks(
    unmappedProducts.data ?? [],
  );
  return (
    <Card>
      <CardHeader title="New advertised ASINs to identify" />
      {unmappedProducts.isPending ? (
        <Loading label="Looking for new advertised ASINs…" />
      ) : unmappedProducts.error ? (
        <ErrorState error={unmappedProducts.error} />
      ) : advertisedBookGroups.length === 0 ? (
        <EmptyState>All advertised ASINs have been identified.</EmptyState>
      ) : (
        <>
          <div className="border-b border-zinc-800 bg-sky-950/20 px-4 py-3">
            <p className="text-xs leading-5 text-zinc-400">
              Amazon Ads supplied these ASINs without a KDP title or format.
              Identify each one to add it to Your books.
            </p>
          </div>
          <div className="divide-y divide-zinc-800">
            {advertisedBookGroups.map((group) => (
              <AdvertisedBookMappingForm key={group.asin} {...group} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function AuditCard() {
  const audit = useAuditEvents();
  return (
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
  );
}

export function SettingsPage() {
  const search = useSearch({ strict: false }) as { tab?: SettingsTab };
  const navigate = useNavigate();
  const books = useBooks();
  const unmappedProducts = useUnmappedAdvertisedProducts();
  const tab = search.tab ?? "profiles";

  // Tab badges surface setup work without opening the section.
  const economicsTotals = (books.data ?? []).reduce(
    (totals, book) => ({
      configured:
        totals.configured +
        book.economics.filter((economics) =>
          book.profileIds.includes(economics.profileId),
        ).length,
      linked: totals.linked + book.profileIds.length,
    }),
    { configured: 0, linked: 0 },
  );
  const newAsinCount = groupAdvertisedBooks(unmappedProducts.data ?? []).length;

  function selectTab(next: SettingsTab) {
    void navigate({
      to: "/settings",
      search: { ...search, tab: next },
      replace: true,
    });
  }

  return (
    <div className="flex w-full min-w-0 max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-bold tracking-tight text-zinc-100">
        Settings & health
      </h1>

      <div className="border-b border-zinc-800">
        <nav className="-mb-px flex gap-6" aria-label="Settings sections">
          {SETTINGS_TABS.map((settingsTab) => (
            <button
              key={settingsTab}
              type="button"
              aria-current={settingsTab === tab ? "page" : undefined}
              onClick={() => selectTab(settingsTab)}
              className={`border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                settingsTab === tab
                  ? "border-sky-500 text-sky-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {TAB_LABELS[settingsTab]}
              {settingsTab === "books" && economicsTotals.linked > 0 ? (
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                    economicsTotals.configured === economicsTotals.linked
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-amber-500/15 text-amber-300"
                  }`}
                >
                  {economicsTotals.configured} of {economicsTotals.linked}
                </span>
              ) : null}
              {settingsTab === "asins" && newAsinCount > 0 ? (
                <span className="ml-2 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300">
                  {newAsinCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </div>

      {tab === "profiles" ? <ProfilesCard /> : null}
      {tab === "books" ? <BooksCard /> : null}
      {tab === "asins" ? <NewAsinsCard /> : null}
      {tab === "audit" ? <AuditCard /> : null}
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
