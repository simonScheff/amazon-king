import { useState, type FormEvent } from "react";
import {
  goalModeSchema,
  type AmazonProfile,
  type Book,
} from "@amazon-king/contracts";
import {
  useAuditEvents,
  useBooks,
  useEnqueueSync,
  useProfiles,
  useSaveBookEconomics,
  useUpdateProfile,
} from "../api/endpoints";
import { useToast } from "../components/toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Input, Select } from "../components/ui/input";
import { Table, Td, Th } from "../components/ui/table";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatDateTime, labelize } from "../lib/format";

function BookEconomicsForm({
  book,
  profiles,
}: {
  book: Book;
  profiles: AmazonProfile[];
}) {
  const save = useSaveBookEconomics(book.id);
  const toast = useToast();
  const [profileId, setProfileId] = useState(profiles[0]?.profileId ?? "");
  const [listPrice, setListPrice] = useState("");
  const [royalty, setRoyalty] = useState("");
  const [targetAcosPct, setTargetAcosPct] = useState("");
  const [goalMode, setGoalMode] = useState<string>("balanced");
  const [notes, setNotes] = useState("");

  const currency =
    profiles.find((p) => p.profileId === profileId)?.currencyCode ?? "USD";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const pct = targetAcosPct.trim();
    save.mutate(
      {
        profileId,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        currency,
        listPrice,
        estimatedRoyaltyPerSale: royalty,
        targetAcos: pct === "" ? null : Number(pct) / 100,
        goalMode: goalMode as (typeof goalModeSchema.options)[number],
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: () => toast(`Economics saved for ${book.title}`),
        onError: (err) => toast(`Save failed: ${err.message}`, "error"),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Profile
          <Select
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            required
          >
            {profiles.map((p) => (
              <option key={p.profileId} value={p.profileId}>
                {p.profileId} ({p.countryCode})
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          List price ({currency})
          <Input
            inputMode="decimal"
            required
            placeholder="9.99"
            value={listPrice}
            onChange={(e) => setListPrice(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Royalty per sale ({currency})
          <Input
            inputMode="decimal"
            required
            placeholder="2.04"
            value={royalty}
            onChange={(e) => setRoyalty(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Target ACoS (%)
          <Input
            inputMode="decimal"
            placeholder="e.g. 25"
            value={targetAcosPct}
            onChange={(e) => setTargetAcosPct(e.target.value)}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Goal mode
          <Select
            value={goalMode}
            onChange={(e) => setGoalMode(e.target.value)}
          >
            {goalModeSchema.options.map((g) => (
              <option key={g} value={g}>
                {labelize(g)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-500">
          Notes (optional)
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={save.isPending || !profileId}
        >
          {save.isPending ? "Saving…" : "Save economics"}
        </Button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const books = useBooks();
  const profiles = useProfiles();
  const audit = useAuditEvents();
  const toast = useToast();

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-lg font-semibold text-zinc-100">Settings & health</h1>

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
          <Loading />
        ) : books.error ? (
          <ErrorState error={books.error} />
        ) : books.data.length === 0 ? (
          <EmptyState>
            No books imported yet. Economics are required before royalty and
            profit estimates appear.
          </EmptyState>
        ) : (
          <div className="divide-y divide-zinc-800">
            {books.data.map((b) => (
              <div key={b.id} className="px-4 py-3">
                <p className="mb-2 text-sm font-medium text-zinc-200">
                  {b.title}{" "}
                  <span className="text-xs font-normal text-zinc-500">
                    {b.asin} · {b.format} · {b.status}
                  </span>
                </p>
                {(profiles.data ?? []).length > 0 && (
                  <BookEconomicsForm book={b} profiles={profiles.data ?? []} />
                )}
              </div>
            ))}
          </div>
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
