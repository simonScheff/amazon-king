import type { NegativeListRow } from "@amazon-king/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NegativesPage } from "./negatives";

const mocks = vi.hoisted(() => ({
  useNegatives: vi.fn(),
  useProfiles: vi.fn(),
  useBooks: vi.fn(),
  useSearchTermExclusions: vi.fn(),
  useSearch: vi.fn(
    () =>
      ({}) as {
        days?: number | "mtd";
        books?: string[];
        country?: string;
        kind?: "keyword" | "product";
      },
  ),
  useNavigate: vi.fn(() => vi.fn()),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useSearch: mocks.useSearch,
  useNavigate: mocks.useNavigate,
}));

vi.mock("../api/endpoints", () => ({
  useNegatives: mocks.useNegatives,
  useProfiles: mocks.useProfiles,
  useBooks: mocks.useBooks,
  useSearchTermExclusions: mocks.useSearchTermExclusions,
  useCreateSearchTermExclusion: () => ({ isPending: false, mutate: vi.fn() }),
  useDeleteSearchTermExclusion: () => ({ isPending: false, mutate: vi.fn() }),
  useCountrySpend: () => ({ data: undefined }),
}));

const PROFILES = [
  {
    profileId: "profile-us",
    accountId: "account-1",
    region: "NA",
    countryCode: "US",
    currencyCode: "USD",
    timezone: "America/Los_Angeles",
    accountType: "seller",
    enabled: true,
    writeEnabled: false,
  },
  {
    profileId: "profile-de",
    accountId: "account-2",
    region: "EU",
    countryCode: "DE",
    currencyCode: "EUR",
    timezone: "Europe/Berlin",
    accountType: "seller",
    enabled: true,
    writeEnabled: false,
  },
];

const EMPTY_PERIOD = {
  impressions: 0,
  clicks: 0,
  cost: "0.0000",
  sales: "0.0000",
  orders: 0,
  units: 0,
  acos: null as number | null,
  estimatedRoyalty: "0.0000",
  estimatedAdProfit: "0.0000",
  economicsMissing: false,
};

function negative(
  value: string,
  overrides: Partial<NegativeListRow> = {},
): NegativeListRow {
  return {
    kind: "keyword",
    value,
    matchTypes: ["NEGATIVE_EXACT"],
    countryCodes: ["US"],
    currency: "USD",
    bookIds: [],
    blockingCampaignCount: 1,
    stillServingCampaignCount: 0,
    pausedCampaignCount: 0,
    excludedEverywhere: false,
    catalogBookId: null,
    firstSeenAt: "2026-08-10T00:00:00.000Z",
    lastServedAt: "2026-08-13",
    before: { ...EMPTY_PERIOD },
    window: {
      ...EMPTY_PERIOD,
      impressions: 100,
      clicks: 10,
      cost: "8.0000",
      sales: "20.0000",
      orders: 2,
      units: 2,
      acos: 0.4,
      estimatedRoyalty: "10.0000",
      estimatedAdProfit: "2.0000",
    },
    dataCurrentThrough: "2026-08-13",
    ...overrides,
  };
}

function rowTexts(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("td a")?.textContent ?? "");
}

describe("NegativesPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSearch.mockReturnValue({});
    mocks.useProfiles.mockReturnValue({ data: PROFILES, isPending: false });
    mocks.useBooks.mockReturnValue({ data: [], isPending: false });
    mocks.useSearchTermExclusions.mockReturnValue({
      isPending: false,
      error: null,
      data: { exclusions: [] },
    });
    mocks.useNegatives.mockReturnValue({
      isPending: false,
      error: null,
      data: [
        negative("free books", {
          stillServingCampaignCount: 2,
          blockingCampaignCount: 1,
        }),
        negative("used to sell", {
          before: {
            ...EMPTY_PERIOD,
            orders: 4,
            cost: "12.0000",
            sales: "30.0000",
            acos: 0.4,
          },
          blockingCampaignCount: 3,
        }),
        negative("B0CATALOG1", {
          kind: "product",
          matchTypes: ["ASIN_SAME_AS"],
          catalogBookId: "book-1",
          blockingCampaignCount: 1,
        }),
      ],
    });
  });

  it("shows the selected-window profit for every negative", () => {
    render(<NegativesPage />);

    expect(mocks.useNegatives).toHaveBeenCalledWith(
      30,
      undefined,
      undefined,
      undefined,
    );
    expect(
      screen.getByRole("columnheader", { name: "30-day profit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("free books 30-day profit: Profitable"),
    ).toBeInTheDocument();
  });

  it("sorts leaks first by default and surfaces still-serving in amber", () => {
    render(<NegativesPage />);

    expect(rowTexts()).toEqual(["free books", "used to sell", "B0CATALOG1"]);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("2").closest("span")).toHaveClass("text-amber-300");
  });

  it("filters with the insight chips", () => {
    render(<NegativesPage />);

    fireEvent.click(screen.getByRole("button", { name: "1 still serving" }));
    expect(rowTexts()).toEqual(["free books"]);

    fireEvent.click(screen.getByRole("button", { name: "1 used to sell" }));
    expect(rowTexts()).toEqual(["used to sell"]);

    fireEvent.click(screen.getByRole("button", { name: "1 your catalog" }));
    expect(rowTexts()).toEqual(["B0CATALOG1"]);
  });

  it("filters keywords vs products", () => {
    const navigate = vi.fn();
    mocks.useNavigate.mockReturnValue(navigate);
    render(<NegativesPage />);

    fireEvent.click(screen.getByRole("button", { name: "Products" }));
    const call = navigate.mock.calls.at(-1)?.[0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe("/negatives");
    expect(call.search({ books: ["1"] })).toEqual({
      books: ["1"],
      kind: "product",
    });

    mocks.useSearch.mockReturnValue({ kind: "product" });
    cleanup();
    render(<NegativesPage />);
    expect(mocks.useNegatives).toHaveBeenCalledWith(
      30,
      undefined,
      undefined,
      "product",
    );
    expect(rowTexts()).toEqual(["B0CATALOG1"]);
    expect(screen.getByText("Product")).toBeInTheDocument();
    expect(screen.getByText("Your catalog")).toBeInTheDocument();
  });

  it("filters by the search box", () => {
    render(<NegativesPage />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "CATALOG" },
    });
    expect(rowTexts()).toEqual(["B0CATALOG1"]);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No negatives match “zzz”.")).toBeInTheDocument();
  });

  it("passes the global product filter and market to the query", () => {
    mocks.useSearch.mockReturnValue({
      books: ["book-1", "book-2"],
      country: "DE",
    });
    render(<NegativesPage />);

    expect(mocks.useNegatives).toHaveBeenCalledWith(
      30,
      ["book-1", "book-2"],
      "DE",
      undefined,
    );
  });

  it("changes the window through the timeframe selector", () => {
    const navigate = vi.fn();
    mocks.useNavigate.mockReturnValue(navigate);
    render(<NegativesPage />);

    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    const call = navigate.mock.calls.at(-1)?.[0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe("/negatives");
    expect(call.search({ books: ["book-1"], country: "DE" })).toEqual({
      books: ["book-1"],
      country: "DE",
      days: 7,
    });
  });

  it("shows an empty state naming the market", () => {
    mocks.useSearch.mockReturnValue({ country: "DE" });
    mocks.useNegatives.mockReturnValue({
      isPending: false,
      error: null,
      data: [],
    });
    render(<NegativesPage />);

    expect(screen.getByText("No negatives in Germany.")).toBeInTheDocument();
  });

  it("offers exclude-everywhere on keywords and marks excluded terms", () => {
    mocks.useSearchTermExclusions.mockReturnValue({
      isPending: false,
      error: null,
      data: {
        exclusions: [
          { term: "free books", createdAt: "2026-08-20T10:00:00.000Z" },
        ],
      },
    });
    render(<NegativesPage />);

    expect(
      screen.getByRole("button", { name: "Excluded everywhere" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Exclude everywhere" }),
    ).toHaveLength(1);
  });

  it("shows sold-before orders and spend", () => {
    render(<NegativesPage />);

    expect(screen.getByText("4 orders")).toBeInTheDocument();
    expect(screen.getByText(/\$12\.00/)).toBeInTheDocument();
  });
});
