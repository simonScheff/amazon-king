import type { NegativeDetail } from "@amazon-king/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NegativeDetailPage } from "./negative-detail";

const mocks = vi.hoisted(() => ({
  useNegative: vi.fn(),
  useSearchTermExclusions: vi.fn(),
  useSearch: vi.fn(),
  useParams: vi.fn(() => ({ kind: "keyword", value: "free books" })),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useParams: () => mocks.useParams(),
  useSearch: mocks.useSearch,
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/endpoints", () => ({
  useNegative: mocks.useNegative,
  useSearchTermExclusions: mocks.useSearchTermExclusions,
  useCreateSearchTermExclusion: () => ({ isPending: false, mutate: vi.fn() }),
  useDeleteSearchTermExclusion: () => ({ isPending: false, mutate: vi.fn() }),
  useCreateCampaignNegatives: () => ({ isPending: false, mutate: vi.fn() }),
  useRemoveNegative: () => ({ isPending: false, mutate: vi.fn() }),
}));

const WINDOW = {
  impressions: 100,
  clicks: 10,
  cost: "8.0000",
  sales: "20.0000",
  orders: 2,
  units: 2,
  acos: 0.4,
  estimatedRoyalty: "10.0000",
  estimatedAdProfit: "2.0000",
  economicsMissing: false,
};

function campaignTotals(
  overrides: Partial<NegativeDetail["unblockedCampaigns"][number]> = {},
): NegativeDetail["unblockedCampaigns"][number] {
  return {
    profileId: "profile-us",
    campaignId: "campaign-leak",
    name: "Leak",
    state: "enabled",
    totals: {
      impressions: 40,
      clicks: 4,
      cost: "3.0000",
      sales: "0.0000",
      orders: 0,
      units: 0,
    },
    estimatedRoyalty: "0.0000",
    estimatedAdProfit: "-3.0000",
    economicsMissing: false,
    ...overrides,
  };
}

function blocking(
  overrides: Partial<NegativeDetail["blockingCampaigns"][number]> = {},
): NegativeDetail["blockingCampaigns"][number] {
  return {
    profileId: "profile-us",
    campaignId: "campaign-blocked",
    name: "Blocked",
    state: "enabled",
    totals: {
      impressions: 60,
      clicks: 6,
      cost: "5.0000",
      sales: "20.0000",
      orders: 2,
      units: 2,
    },
    estimatedRoyalty: "10.0000",
    estimatedAdProfit: "5.0000",
    economicsMissing: false,
    negativeId: "neg-1",
    matchType: "NEGATIVE_EXACT",
    level: "campaign",
    adGroupId: null,
    adGroupName: null,
    negativeState: "enabled",
    firstSeenAt: "2026-08-10T00:00:00.000Z",
    currentlyBlocks: true,
    ...overrides,
  };
}

function detail(overrides: Partial<NegativeDetail> = {}): NegativeDetail {
  return {
    kind: "keyword",
    value: "free books",
    matchTypes: ["NEGATIVE_EXACT"],
    countryCode: "US",
    availableCountryCodes: ["US"],
    dateRange: { start: "2026-08-07", end: "2026-08-13" },
    currency: "USD",
    bookIds: [],
    blockingCampaignCount: 1,
    stillServingCampaignCount: 1,
    pausedCampaignCount: 1,
    excludedEverywhere: false,
    catalogBookId: null,
    firstSeenAt: "2026-08-10T00:00:00.000Z",
    lastServedAt: "2026-08-13",
    before: {
      ...WINDOW,
      orders: 4,
      cost: "12.0000",
      sales: "30.0000",
      acos: 0.4,
    },
    window: WINDOW,
    economicsMissing: false,
    dataCurrentThrough: "2026-08-13",
    daily: [
      {
        date: "2026-08-12",
        cost: "3.0000",
        sales: "8.0000",
        estimatedRoyalty: "4.0000",
        estimatedAdProfit: "1.0000",
      },
      {
        date: "2026-08-13",
        cost: "5.0000",
        sales: "12.0000",
        estimatedRoyalty: "6.0000",
        estimatedAdProfit: "1.0000",
      },
    ],
    blockingCampaigns: [blocking()],
    unblockedCampaigns: [campaignTotals()],
    matchedTerms: [],
    hasSearchTermFacts: true,
    ...overrides,
  };
}

describe("NegativeDetailPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.useParams.mockReturnValue({ kind: "keyword", value: "free books" });
    mocks.useSearch.mockReturnValue({ days: 7 });
    mocks.useSearchTermExclusions.mockReturnValue({
      isPending: false,
      error: null,
      data: { exclusions: [] },
    });
    mocks.navigate.mockReset();
    mocks.useNegative.mockReset();
    mocks.useNegative.mockReturnValue({
      isPending: false,
      error: null,
      data: detail(),
    });
  });

  it("renders KPIs, funnel, chart, and both campaign tables", () => {
    render(<NegativeDetailPage />);

    expect(mocks.useNegative).toHaveBeenCalledWith(
      "keyword",
      "free books",
      7,
      undefined,
      undefined,
    );
    expect(
      screen.getByRole("heading", { name: "free books" }),
    ).toBeInTheDocument();
    expect(screen.getByText("View as search term")).toBeInTheDocument();
    expect(screen.getByText("1 still eligible")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Daily performance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Daily performance trend"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "7-day conversion funnel" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Negative applied on (1)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Term can still serve on (1)" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Leak")).toBeInTheDocument();
    expect(screen.getByText("Blocking")).toBeInTheDocument();
    expect(screen.getByText("Still serving")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Re-include" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exclude" })).toBeInTheDocument();
  });

  it("shows a muted not-blocking badge for paused campaigns that still carry the negative", () => {
    mocks.useNegative.mockReturnValue({
      isPending: false,
      error: null,
      data: detail({
        blockingCampaigns: [
          blocking({
            campaignId: "campaign-paused",
            name: "Paused",
            state: "paused",
            currentlyBlocks: false,
          }),
        ],
        unblockedCampaigns: [],
      }),
    });
    render(<NegativeDetailPage />);

    expect(
      screen.getByText("Not blocking · campaign paused"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Every campaign that served this term already blocks it.",
      ),
    ).toBeInTheDocument();
  });

  it("names the negative's own state when it is paused on an enabled campaign", () => {
    mocks.useNegative.mockReturnValue({
      isPending: false,
      error: null,
      data: detail({
        blockingCampaigns: [
          blocking({ negativeState: "paused", currentlyBlocks: false }),
        ],
      }),
    });
    render(<NegativeDetailPage />);

    expect(
      screen.getByText("Not blocking · negative paused"),
    ).toBeInTheDocument();
  });

  it("renders empty coverage copy when no campaign carries the negative", () => {
    mocks.useNegative.mockReturnValue({
      isPending: false,
      error: null,
      data: detail({
        blockingCampaigns: [],
        unblockedCampaigns: [campaignTotals()],
      }),
    });
    render(<NegativeDetailPage />);

    expect(
      screen.getByText("No campaigns currently carry this negative."),
    ).toBeInTheDocument();
  });

  it("compares before vs window totals", () => {
    render(<NegativeDetailPage />);

    expect(
      screen.getByRole("heading", { name: "Before vs this window" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Before first seen")).toBeInTheDocument();
    expect(
      screen.getByText(/Sold before first seen: 4 orders/),
    ).toBeInTheDocument();
  });

  it("lists phrase matches as search-term links", () => {
    mocks.useNegative.mockReturnValue({
      isPending: false,
      error: null,
      data: detail({
        matchTypes: ["NEGATIVE_PHRASE"],
        matchedTerms: ["best free books"],
      }),
    });
    render(<NegativeDetailPage />);

    expect(
      screen.getByRole("heading", { name: "Also matching in this window" }),
    ).toBeInTheDocument();
    expect(screen.getByText("best free books")).toBeInTheDocument();
  });

  it("offers exclude everywhere on keywords", () => {
    render(<NegativeDetailPage />);

    expect(
      screen.getByRole("button", { name: "Exclude everywhere" }),
    ).toBeInTheDocument();
  });

  it("hides exclude everywhere on product negatives", () => {
    mocks.useParams.mockReturnValue({ kind: "product", value: "B0CATALOG1" });
    mocks.useNegative.mockReturnValue({
      isPending: false,
      error: null,
      data: detail({
        kind: "product",
        value: "B0CATALOG1",
        matchTypes: ["ASIN_SAME_AS"],
        catalogBookId: "book-1",
      }),
    });
    render(<NegativeDetailPage />);

    expect(screen.getByText("Your catalog")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Exclude everywhere" }),
    ).not.toBeInTheDocument();
  });

  it("rejects an unknown kind", () => {
    mocks.useParams.mockReturnValue({ kind: "nope", value: "x" });
    render(<NegativeDetailPage />);

    expect(screen.getByText("Unknown negative type")).toBeInTheDocument();
  });

  it("switches market through the URL", () => {
    mocks.useNegative.mockReturnValue({
      isPending: false,
      error: null,
      data: detail({ availableCountryCodes: ["US", "GB"] }),
    });
    render(<NegativeDetailPage />);

    fireEvent.change(screen.getByRole("combobox", { name: "Market" }), {
      target: { value: "GB" },
    });
    const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
      to: string;
      params: { kind: string; value: string };
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe("/negatives/$kind/$value");
    expect(call.params).toEqual({ kind: "keyword", value: "free books" });
    expect(call.search({ days: 7, books: ["3"] })).toEqual({
      days: 7,
      books: ["3"],
      country: "GB",
    });
  });
});
