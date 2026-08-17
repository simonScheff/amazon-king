import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  campaignCreationCreateSchema,
  type CampaignCreationCreate,
  type CampaignCreationMatchType,
  type CampaignCreationTargetingType,
} from "@amazon-king/contracts";
import {
  useBooks,
  useCreateCampaignDrafts,
  useProfiles,
} from "../api/endpoints";
import { ApiError, isReauthError } from "../api/client";
import { ReauthDialog } from "../components/reauth-dialog";
import { useToast } from "../components/toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Input, Select } from "../components/ui/input";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { Flag } from "../components/flag";
import { isAsin } from "../lib/asin";
import { useSpendSortedMarketplaces } from "../lib/use-spend-sorted-marketplaces";

const STEPS = [
  "markets",
  "campaign",
  "adgroup",
  "book",
  "keywords",
  "review",
] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLES: Record<Step, string> = {
  markets: "Markets",
  campaign: "Campaign",
  adgroup: "Ad group",
  book: "Book",
  keywords: "Keywords & targets",
  review: "Review",
};

const DECIMAL_RE = /^\d+(\.\d{1,4})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

interface KeywordRow {
  id: number;
  text: string;
  matchType: CampaignCreationMatchType;
  /** Empty means "use the ad group default bid". */
  bid: string;
}

interface TargetRow {
  id: number;
  asin: string;
  /** Empty means "use the ad group default bid". */
  bid: string;
}

let nextKeywordId = 1;
let nextTargetId = 1;

function emptyKeywordRow(): KeywordRow {
  return { id: nextKeywordId++, text: "", matchType: "EXACT", bid: "" };
}

function emptyTargetRow(): TargetRow {
  return { id: nextTargetId++, asin: "", bid: "" };
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-400">
        {label}
      </label>
      {children}
    </div>
  );
}

export function CampaignNewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const profiles = useProfiles();
  const books = useBooks();
  const createDrafts = useCreateCampaignDrafts();
  const [reauthOpen, setReauthOpen] = useState(false);

  // Optional prefill from the cannibalization resolution screen: the search
  // term to advertise, its market, and the finding this campaign resolves.
  const prefill = useSearch({ strict: false }) as {
    recommendationId?: string;
    searchTerm?: string;
    country?: string;
  };
  const prefillTerm = prefill.searchTerm?.trim() ?? "";
  // An ASIN shopper term becomes a product target, not an EXACT keyword.
  const prefillIsAsin = isAsin(prefillTerm);

  const [stepIndex, setStepIndex] = useState(0);
  const [selectedCountries, setSelectedCountries] = useState<string[]>(() =>
    prefill.country ? [prefill.country] : [],
  );
  const [campaignName, setCampaignName] = useState(prefillTerm);
  const [dailyBudget, setDailyBudget] = useState("");
  const [targetingType, setTargetingType] =
    useState<CampaignCreationTargetingType>(prefillTerm ? "MANUAL" : "AUTO");
  const [startDate, setStartDate] = useState(todayIsoDate);
  const [campaignState, setCampaignState] = useState<"enabled" | "paused">(
    "paused",
  );
  const [adGroupName, setAdGroupName] = useState("");
  const [defaultBid, setDefaultBid] = useState("");
  const [bookId, setBookId] = useState("");
  const [keywords, setKeywords] = useState<KeywordRow[]>(() => [
    ...(prefillTerm && !prefillIsAsin
      ? [
          {
            id: nextKeywordId++,
            text: prefillTerm,
            matchType: "EXACT" as const,
            bid: "",
          },
        ]
      : []),
    emptyKeywordRow(),
    emptyKeywordRow(),
    emptyKeywordRow(),
  ]);
  const [targets, setTargets] = useState<TargetRow[]>(() =>
    prefillTerm && prefillIsAsin
      ? [{ id: nextTargetId++, asin: prefillTerm.toUpperCase(), bid: "" }]
      : [],
  );

  const step: Step = STEPS[stepIndex] ?? "markets";
  // No window selector on this page; rank markets by the default 30-day spend.
  const options = useSpendSortedMarketplaces(30);
  const writeEnabledByProfile = useMemo(
    () =>
      new Map((profiles.data ?? []).map((p) => [p.profileId, p.writeEnabled])),
    [profiles.data],
  );

  const selectedOptions = options.filter((o) =>
    selectedCountries.includes(o.countryCode),
  );
  const selectedProfileIds = selectedOptions.flatMap((o) => o.profileIds);

  // Only books with a marketplace ASIN in every selected profile can be
  // advertised by the new campaign in all chosen markets.
  const eligibleBooks = useMemo(
    () =>
      (books.data ?? []).filter((book) =>
        selectedProfileIds.every((profileId) =>
          book.marketplaceAsins.some((m) => m.profileId === profileId),
        ),
      ),
    [books.data, selectedProfileIds],
  );
  const selectedBook = eligibleBooks.find((b) => b.id === bookId);

  const effectiveAdGroupName =
    adGroupName.trim() ||
    (campaignName.trim() ? `${campaignName.trim()} ad group` : "");
  const effectiveKeywords = keywords
    .filter((row) => row.text.trim() !== "")
    .map((row) => ({
      text: row.text.trim(),
      matchType: row.matchType,
      bid: row.bid.trim() || defaultBid.trim(),
    }));
  const effectiveTargets = targets
    .filter((row) => row.asin.trim() !== "")
    .map((row) => ({
      asin: row.asin.trim().toUpperCase(),
      bid: row.bid.trim() || defaultBid.trim(),
    }));

  const stepValid: Record<Step, boolean> = {
    markets: selectedOptions.length >= 1,
    campaign:
      campaignName.trim() !== "" &&
      DECIMAL_RE.test(dailyBudget.trim()) &&
      ISO_DATE_RE.test(startDate),
    adgroup: effectiveAdGroupName !== "" && DECIMAL_RE.test(defaultBid.trim()),
    book: selectedBook !== undefined,
    // AUTO campaigns are targeted by Amazon itself (it rejects manual
    // clauses), so automatic targeting is only valid with no rows filled in;
    // typing a keyword or ASIN flips the campaign to MANUAL via the row
    // handlers, which leaves AUTO + filled rows reachable only by switching
    // back deliberately — block that instead of silently dropping the rows.
    keywords:
      targetingType === "AUTO"
        ? effectiveKeywords.length === 0 && effectiveTargets.length === 0
        : (effectiveKeywords.length >= 1 &&
            effectiveKeywords.every((k) => DECIMAL_RE.test(k.bid))) ||
          (effectiveTargets.length >= 1 &&
            effectiveTargets.every(
              (t) => isAsin(t.asin) && DECIMAL_RE.test(t.bid),
            )),
    review: true,
  };

  function buildPayload(): CampaignCreationCreate {
    return {
      profileIds: selectedProfileIds,
      campaign: {
        name: campaignName.trim(),
        dailyBudget: dailyBudget.trim(),
        targetingType,
        startDate,
        state: campaignState,
      },
      adGroup: { name: effectiveAdGroupName, defaultBid: defaultBid.trim() },
      bookId,
      keywords: targetingType === "AUTO" ? [] : effectiveKeywords,
      ...(targetingType === "MANUAL" && effectiveTargets.length > 0
        ? { targets: effectiveTargets }
        : {}),
      ...(prefill.recommendationId
        ? { cannibalization: { recommendationId: prefill.recommendationId } }
        : {}),
    };
  }

  const payloadReview = campaignCreationCreateSchema.safeParse(buildPayload());

  function toggleCountry(countryCode: string) {
    setSelectedCountries((current) =>
      current.includes(countryCode)
        ? current.filter((c) => c !== countryCode)
        : [...current, countryCode],
    );
  }

  function updateKeyword(id: number, patch: Partial<Omit<KeywordRow, "id">>) {
    setKeywords((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
    // Entering a keyword is intent for manual targeting — never let an AUTO
    // campaign silently swallow it (Amazon rejects manual clauses there).
    if (patch.text?.trim()) setTargetingType("MANUAL");
  }

  function updateTarget(id: number, patch: Partial<Omit<TargetRow, "id">>) {
    setTargets((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
    if (patch.asin?.trim()) setTargetingType("MANUAL");
  }

  function submit() {
    if (!payloadReview.success) return;
    createDrafts.mutate(payloadReview.data, {
      onSuccess: (result) => {
        toast(
          prefill.recommendationId
            ? `Created ${result.changeSets.length} draft change sets — the negative keywords for the other campaigns unlock once the new campaign is applied`
            : `Created ${result.changeSets.length} draft change sets — review them in the Change center`,
        );
        void navigate({ to: "/changes" });
      },
      onError: (err) => {
        if (isReauthError(err)) setReauthOpen(true);
      },
    });
  }

  if (profiles.isPending || books.isPending) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          New campaign
        </h1>
        <Card>
          <Loading />
        </Card>
      </div>
    );
  }
  if (profiles.error) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          New campaign
        </h1>
        <Card>
          <ErrorState error={profiles.error} />
        </Card>
      </div>
    );
  }

  const submitError = isReauthError(createDrafts.error)
    ? null
    : createDrafts.error instanceof ApiError
      ? createDrafts.error.message
      : createDrafts.error instanceof Error
        ? createDrafts.error.message
        : null;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">
          New campaign
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Step {stepIndex + 1} of {STEPS.length} · {STEP_TITLES[step]} — this
          creates draft change sets; nothing is sent to Amazon until you apply
          them in the Change center.
        </p>
      </div>

      {prefill.recommendationId ? (
        <div className="rounded-md border border-sky-800 bg-sky-950/20 px-4 py-3 text-sm leading-6 text-sky-200">
          Resolving a cannibalization finding
          {prefillTerm ? (
            <>
              {" "}
              for “<span className="font-medium">{prefillTerm}</span>”
            </>
          ) : null}
          . When you finish, the app also drafts this term as a{" "}
          {prefillIsAsin ? "negative ASIN target" : "negative exact"} in the
          conflicting campaigns — locked until this new campaign is applied to
          Amazon, so the term is never blocked everywhere.
        </div>
      ) : null}

      <Card>
        <CardHeader title={STEP_TITLES[step]} />
        <CardBody className="flex flex-col gap-4">
          {step === "markets" &&
            (options.length === 0 ? (
              <EmptyState>
                No enabled profiles yet. Connect Amazon Ads and enable a profile
                in Settings first.
              </EmptyState>
            ) : (
              options.map((option) => {
                const writesDisabled = option.profileIds.some(
                  (profileId) => !writeEnabledByProfile.get(profileId),
                );
                return (
                  <label
                    key={option.countryCode}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2.5 hover:bg-zinc-800/50"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-sky-600"
                      checked={selectedCountries.includes(option.countryCode)}
                      onChange={() => toggleCountry(option.countryCode)}
                      aria-label={`${option.countryName} market`}
                    />
                    <Flag countryCode={option.countryCode} />
                    <span className="text-sm text-zinc-100">
                      {option.countryName}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {option.currencyCodes.join(" / ")}
                    </span>
                    {writesDisabled && (
                      <Badge tone="warning">
                        writes disabled — applying will be blocked until enabled
                        in Settings
                      </Badge>
                    )}
                  </label>
                );
              })
            ))}

          {step === "campaign" && (
            <>
              <Field label="Campaign name" htmlFor="campaign-name">
                <Input
                  id="campaign-name"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="My book — Sponsored Products"
                />
              </Field>
              <Field label="Daily budget" htmlFor="daily-budget">
                <Input
                  id="daily-budget"
                  inputMode="decimal"
                  value={dailyBudget}
                  onChange={(e) => setDailyBudget(e.target.value)}
                  placeholder="10.00"
                />
              </Field>
              <Field label="Targeting type" htmlFor="targeting-type">
                <Select
                  id="targeting-type"
                  value={targetingType}
                  onChange={(e) =>
                    setTargetingType(
                      e.target.value as CampaignCreationTargetingType,
                    )
                  }
                >
                  <option value="AUTO">Automatic</option>
                  <option value="MANUAL">Manual</option>
                </Select>
              </Field>
              <Field label="Start date" htmlFor="start-date">
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </Field>
              <Field label="Initial state" htmlFor="campaign-state">
                <Select
                  id="campaign-state"
                  value={campaignState}
                  onChange={(e) =>
                    setCampaignState(e.target.value as "enabled" | "paused")
                  }
                >
                  <option value="paused">Paused</option>
                  <option value="enabled">Enabled</option>
                </Select>
              </Field>
            </>
          )}

          {step === "adgroup" && (
            <>
              <Field label="Ad group name" htmlFor="adgroup-name">
                <Input
                  id="adgroup-name"
                  value={adGroupName}
                  onChange={(e) => setAdGroupName(e.target.value)}
                  placeholder={
                    campaignName.trim()
                      ? `${campaignName.trim()} ad group`
                      : "Ad group name"
                  }
                />
              </Field>
              <Field label="Default bid" htmlFor="default-bid">
                <Input
                  id="default-bid"
                  inputMode="decimal"
                  value={defaultBid}
                  onChange={(e) => setDefaultBid(e.target.value)}
                  placeholder="0.50"
                />
              </Field>
            </>
          )}

          {step === "book" &&
            (eligibleBooks.length === 0 ? (
              <EmptyState>
                No book in your catalog has a marketplace ASIN in every selected
                market. Map the book&apos;s ASINs in Settings first.
              </EmptyState>
            ) : (
              <Field label="Book" htmlFor="book">
                <Select
                  id="book"
                  value={bookId}
                  onChange={(e) => setBookId(e.target.value)}
                >
                  <option value="">Select a book…</option>
                  {eligibleBooks.map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.title} ({book.format})
                    </option>
                  ))}
                </Select>
              </Field>
            ))}

          {step === "keywords" && (
            <>
              {targetingType === "AUTO" ? (
                effectiveKeywords.length > 0 || effectiveTargets.length > 0 ? (
                  <p role="alert" className="text-sm leading-6 text-amber-400">
                    Automatic targeting can&apos;t carry keywords or product
                    targets — switch the campaign to Manual on the Campaign
                    step, or remove these rows.
                  </p>
                ) : (
                  <p className="text-sm leading-6 text-zinc-400">
                    Automatic targeting is selected — Amazon creates the close
                    match, loose match, substitutes, and complements targets
                    itself. Entering a keyword or product target below switches
                    the campaign to manual targeting.
                  </p>
                )
              ) : null}
              {keywords.map((row, index) => (
                <div key={row.id} className="flex flex-wrap items-center gap-2">
                  <Input
                    className="min-w-40 flex-1"
                    aria-label={`Keyword ${index + 1} text`}
                    placeholder="Keyword text"
                    value={row.text}
                    onChange={(e) =>
                      updateKeyword(row.id, { text: e.target.value })
                    }
                  />
                  <Select
                    aria-label={`Keyword ${index + 1} match type`}
                    value={row.matchType}
                    onChange={(e) =>
                      updateKeyword(row.id, {
                        matchType: e.target.value as CampaignCreationMatchType,
                      })
                    }
                  >
                    <option value="EXACT">Exact</option>
                    <option value="PHRASE">Phrase</option>
                    <option value="BROAD">Broad</option>
                  </Select>
                  <Input
                    className="w-28"
                    aria-label={`Keyword ${index + 1} bid`}
                    inputMode="decimal"
                    placeholder={defaultBid.trim() || "Bid"}
                    value={row.bid}
                    onChange={(e) =>
                      updateKeyword(row.id, { bid: e.target.value })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove keyword ${index + 1}`}
                    onClick={() =>
                      setKeywords((rows) => rows.filter((r) => r.id !== row.id))
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setKeywords((rows) => [...rows, emptyKeywordRow()])
                  }
                >
                  Add keyword
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                Rows without a bid use the ad group default bid. Empty rows are
                ignored.
              </p>
              <div className="border-t border-zinc-800 pt-4">
                <p className="text-sm font-medium text-zinc-200">
                  Product targets (ASINs)
                </p>
                <p className="mt-1 text-xs leading-5 text-zinc-500">
                  Product targets show the book on those products&apos; detail
                  pages instead of matching shopper queries. ASINs start with B0
                  and are 10 characters; bids work like keyword bids.
                </p>
                {targets.map((row, index) => {
                  const asinInvalid =
                    row.asin.trim() !== "" && !isAsin(row.asin);
                  return (
                    <div
                      key={row.id}
                      className="mt-2 flex flex-wrap items-center gap-2"
                    >
                      <Input
                        className="min-w-40 flex-1"
                        aria-label={`Product target ${index + 1} ASIN`}
                        placeholder="B0XXXXXXXX"
                        value={row.asin}
                        onChange={(e) =>
                          updateTarget(row.id, { asin: e.target.value })
                        }
                      />
                      <Input
                        className="w-28"
                        aria-label={`Product target ${index + 1} bid`}
                        inputMode="decimal"
                        placeholder={defaultBid.trim() || "Bid"}
                        value={row.bid}
                        onChange={(e) =>
                          updateTarget(row.id, { bid: e.target.value })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove product target ${index + 1}`}
                        onClick={() =>
                          setTargets((rows) =>
                            rows.filter((r) => r.id !== row.id),
                          )
                        }
                      >
                        Remove
                      </Button>
                      {asinInvalid ? (
                        <p role="alert" className="w-full text-xs text-red-400">
                          Expected a 10-character ASIN starting with B0
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setTargets((rows) => [...rows, emptyTargetRow()])
                    }
                  >
                    Add product target
                  </Button>
                </div>
              </div>
            </>
          )}

          {step === "review" && (
            <>
              {!payloadReview.success &&
                payloadReview.error.issues.map((issue, index) => (
                  <div
                    key={index}
                    role="alert"
                    className="rounded-lg border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-300"
                  >
                    {issue.path.join(".")}: {issue.message}
                  </div>
                ))}
              {selectedOptions.map((option) => (
                <Card key={option.countryCode}>
                  <CardHeader
                    title={
                      <span className="inline-flex items-center gap-2">
                        <Flag countryCode={option.countryCode} />
                        {option.countryName}
                        <span className="text-xs font-normal text-zinc-500">
                          {option.currencyCodes.join(" / ")}
                        </span>
                      </span>
                    }
                  />
                  <CardBody className="flex flex-col gap-2 text-sm text-zinc-300">
                    <p>
                      <span className="text-zinc-500">Campaign: </span>
                      {campaignName.trim()} · {dailyBudget.trim()}/day ·{" "}
                      {targetingType === "AUTO" ? "Automatic" : "Manual"} ·
                      starts {startDate} · {campaignState}
                    </p>
                    <p>
                      <span className="text-zinc-500">Ad group: </span>
                      {effectiveAdGroupName} · default bid {defaultBid.trim()}
                    </p>
                    <p>
                      <span className="text-zinc-500">Book: </span>
                      {selectedBook
                        ? `${selectedBook.title} (${selectedBook.format})`
                        : "—"}
                    </p>
                    {targetingType === "AUTO" ? (
                      <p>
                        <span className="text-zinc-500">Targeting: </span>
                        Automatic — Amazon creates and manages the targets
                      </p>
                    ) : (
                      <div>
                        <span className="text-zinc-500">Keywords: </span>
                        <ul className="mt-1 list-inside list-disc">
                          {effectiveKeywords.map((keyword, index) => (
                            <li key={index}>
                              {keyword.text} · {keyword.matchType.toLowerCase()}{" "}
                              · bid {keyword.bid}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {targetingType === "MANUAL" &&
                    targets.some((row) => row.asin.trim() !== "") ? (
                      <div>
                        <span className="text-zinc-500">Product targets: </span>
                        <ul className="mt-1 list-inside list-disc">
                          {targets
                            .filter((row) => row.asin.trim() !== "")
                            .map((row) => (
                              <li key={row.id}>
                                {row.asin.trim().toUpperCase()} · bid{" "}
                                {row.bid.trim() || "ad group default"}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              ))}
            </>
          )}
        </CardBody>
      </Card>

      {submitError && (
        <div
          role="alert"
          className="rounded-lg border border-red-900 bg-red-950 px-4 py-3 text-sm text-red-300"
        >
          {submitError}
        </div>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          disabled={stepIndex === 0}
          onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
        >
          Back
        </Button>
        {step === "review" ? (
          <Button
            variant="primary"
            disabled={!payloadReview.success || createDrafts.isPending}
            onClick={submit}
          >
            {createDrafts.isPending
              ? "Creating drafts…"
              : "Create draft change sets"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!stepValid[step]}
            onClick={() =>
              setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))
            }
          >
            Next
          </Button>
        )}
      </div>
      <ReauthDialog open={reauthOpen} onClose={() => setReauthOpen(false)} />
    </div>
  );
}
