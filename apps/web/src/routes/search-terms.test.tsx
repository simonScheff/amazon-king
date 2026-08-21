import type { SearchTermListRow } from "@amazon-king/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchTermsPage } from "./search-terms";

const mocks = vi.hoisted(() => ({
  useSearchTerms: vi.fn(),
  useProfiles: vi.fn(),
  useBooks: vi.fn(),
  useSearch: vi.fn(
    () => ({}) as { days?: number | "mtd"; books?: string[]; country?: string },
  ),
  useNavigate: vi.fn(() => vi.fn()),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useSearch: mocks.useSearch,
  useNavigate: mocks.useNavigate,
}));

vi.mock("../api/endpoints", () => ({
  useSearchTerms: mocks.useSearchTerms,
  useProfiles: mocks.useProfiles,
  useBooks: mocks.useBooks,
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

function searchTerm(
  term: string,
  overrides: Partial<SearchTermListRow> = {},
): SearchTermListRow {
  return {
    searchTerm: term,
    campaignCount: 2,
    countryCodes: ["US"],
    currency: "USD",
    totals: {
      impressions: 100,
      clicks: 10,
      cost: "8.0000",
      sales: "20.0000",
      orders: 2,
      units: 2,
      acos: 0.4,
    },
    estimatedRoyalty: "10.0000",
    estimatedAdProfit: "2.0000",
    economicsMissing: false,
    dataCurrentThrough: "2026-08-13",
    bookIds: [],
    ...overrides,
  };
}

function rowTexts(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1) // header row
    .map((row) => row.querySelector("td a")?.textContent ?? "");
}

describe("SearchTermsPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSearch.mockReturnValue({});
    mocks.useProfiles.mockReturnValue({ data: PROFILES, isPending: false });
    mocks.useBooks.mockReturnValue({ data: [], isPending: false });
    mocks.useSearchTerms.mockReturnValue({
      isPending: false,
      error: null,
      data: [
        searchTerm("fantasy books"),
        searchTerm("dragons", {
          estimatedRoyalty: "5.0000",
          estimatedAdProfit: "-3.0000",
        }),
        searchTerm("unmapped series", {
          estimatedRoyalty: null,
          estimatedAdProfit: null,
          economicsMissing: true,
        }),
      ],
    });
  });

  it("shows the thirty-day result for every aggregated search term", () => {
    render(<SearchTermsPage />);

    expect(mocks.useSearchTerms).toHaveBeenCalledWith(30, undefined, undefined);
    expect(
      screen.getByRole("columnheader", { name: "30-day profit" }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("columnheader", { name: /Search term/ }),
      ).getByRole("button", { name: /30-day profit/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Campaigns" }),
    ).toBeInTheDocument();

    const profitable = screen.getByLabelText(
      "fantasy books 30-day profit: Profitable",
    );
    expect(within(profitable).getByText("Profitable")).toBeInTheDocument();
    expect(within(profitable).getByText("$2.00")).toBeInTheDocument();

    const loss = screen.getByLabelText("dragons 30-day profit: Not profitable");
    expect(within(loss).getByText("Not profitable")).toBeInTheDocument();
    expect(within(loss).getByText("-$3.00")).toBeInTheDocument();

    expect(
      within(
        screen.getByLabelText(
          "unmapped series 30-day profit: Profit unavailable",
        ),
      ).getByText("Missing economics"),
    ).toBeInTheDocument();
  });

  it("shows the market flags of each search term", () => {
    mocks.useSearchTerms.mockReturnValue({
      isPending: false,
      error: null,
      data: [
        searchTerm("fantasy books", { countryCodes: ["US"] }),
        searchTerm("dragons", { countryCodes: ["DE", "US"] }),
      ],
    });
    render(<SearchTermsPage />);

    expect(
      screen.getByRole("columnheader", { name: "Market" }),
    ).toBeInTheDocument();
    expect(screen.getByTitle("United States")).toHaveTextContent("US");
    expect(
      screen.getByTitle("United States").querySelector(".fi.fi-us"),
    ).not.toBeNull();
    expect(screen.getByTitle("Germany, United States")).toHaveTextContent(
      "DE US",
    );
  });

  it("sorts by a column when its header is clicked and toggles direction", () => {
    mocks.useSearchTerms.mockReturnValue({
      isPending: false,
      error: null,
      data: [
        searchTerm("beta", {
          totals: { ...searchTerm("beta").totals, orders: 3 },
          estimatedAdProfit: "5.0000",
        }),
        searchTerm("alpha", {
          totals: { ...searchTerm("alpha").totals, orders: 1 },
          estimatedAdProfit: "-1.0000",
        }),
        searchTerm("gamma", {
          totals: { ...searchTerm("gamma").totals, orders: 2 },
          estimatedRoyalty: null,
          estimatedAdProfit: null,
          economicsMissing: true,
        }),
      ],
    });
    render(<SearchTermsPage />);

    // Default sort: spend desc (all equal here, so insertion order).
    expect(rowTexts()).toEqual(["beta", "alpha", "gamma"]);

    fireEvent.click(screen.getByRole("button", { name: /Search term/ }));
    expect(rowTexts()).toEqual(["alpha", "beta", "gamma"]);

    fireEvent.click(screen.getByRole("button", { name: /Search term/ }));
    expect(rowTexts()).toEqual(["gamma", "beta", "alpha"]);

    fireEvent.click(screen.getByRole("button", { name: /Orders/ }));
    expect(rowTexts()).toEqual(["beta", "gamma", "alpha"]);

    // Profit desc: unavailable profit (gamma) sorts last.
    fireEvent.click(
      within(
        screen.getByRole("columnheader", { name: /Search term/ }),
      ).getByRole("button", { name: /30-day profit/ }),
    );
    expect(rowTexts()).toEqual(["beta", "alpha", "gamma"]);
  });

  it("filters terms by the search box", () => {
    render(<SearchTermsPage />);
    expect(rowTexts()).toHaveLength(3);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "DRAGON" },
    });
    expect(rowTexts()).toEqual(["dragons"]);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz" },
    });
    expect(
      screen.getByText("No search terms match “zzz”."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(rowTexts()).toHaveLength(3);
  });

  it("passes the global product filter to the query", () => {
    mocks.useSearch.mockReturnValue({ books: ["book-1", "book-2"] });
    render(<SearchTermsPage />);

    expect(mocks.useSearchTerms).toHaveBeenCalledWith(
      30,
      ["book-1", "book-2"],
      undefined,
    );
    // The per-page product dropdown is gone — the global filter in the app
    // shell owns product selection now.
    expect(
      screen.queryByRole("combobox", { name: "Filter by product" }),
    ).not.toBeInTheDocument();
  });

  it("filters by market through the URL and passes it to the query", () => {
    const navigate = vi.fn();
    mocks.useNavigate.mockReturnValue(navigate);
    mocks.useSearch.mockReturnValue({ books: ["book-1"], country: "DE" });
    render(<SearchTermsPage />);

    expect(mocks.useSearchTerms).toHaveBeenCalledWith(30, ["book-1"], "DE");

    const marketFilter = screen.getByRole("button", {
      name: "Filter by market",
    });
    fireEvent.click(marketFilter);
    fireEvent.click(
      screen.getByRole("option", { name: /Germany/ }).querySelector("button")!,
    );
    const call = navigate.mock.calls.at(-1)?.[0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
      replace: boolean;
    };
    expect(call.to).toBe("/search-terms");
    expect(call.replace).toBe(true);
    // The functional update preserves the inherited books param.
    expect(call.search({ books: ["book-1"], country: "DE" })).toEqual({
      books: ["book-1"],
      country: "DE",
    });

    // "All markets" clears the country without dropping the product filter.
    fireEvent.click(marketFilter);
    fireEvent.click(
      screen
        .getByRole("option", { name: "All markets" })
        .querySelector("button")!,
    );
    const cleared = navigate.mock.calls.at(-1)?.[0] as typeof call;
    expect(cleared.search({ books: ["book-1"], country: "DE" })).toEqual({
      books: ["book-1"],
      country: undefined,
    });
  });

  it("changes the profit window through the timeframe selector", () => {
    const navigate = vi.fn();
    mocks.useNavigate.mockReturnValue(navigate);
    render(<SearchTermsPage />);

    // The default 30-day window is pressed.
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    const call = navigate.mock.calls.at(-1)?.[0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
      replace: boolean;
    };
    expect(call.to).toBe("/search-terms");
    expect(call.replace).toBe(true);
    // The functional update preserves the other filters.
    expect(call.search({ books: ["book-1"], country: "DE" })).toEqual({
      books: ["book-1"],
      country: "DE",
      days: 7,
    });
  });

  it("uses the window from the URL for the query and profit labels", () => {
    mocks.useSearch.mockReturnValue({ days: 14 });
    render(<SearchTermsPage />);

    expect(mocks.useSearchTerms).toHaveBeenCalledWith(14, undefined, undefined);
    expect(
      screen.getByRole("columnheader", { name: "14-day profit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("fantasy books 14-day profit: Profitable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "14d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("labels the month-to-date window", () => {
    mocks.useSearch.mockReturnValue({ days: "mtd" });
    render(<SearchTermsPage />);

    expect(mocks.useSearchTerms).toHaveBeenCalledWith(
      "mtd",
      undefined,
      undefined,
    );
    expect(
      screen.getByRole("columnheader", { name: "MTD profit" }),
    ).toBeInTheDocument();
  });

  it("shows an empty state naming the market when it has no search terms", () => {
    mocks.useSearch.mockReturnValue({ country: "DE" });
    mocks.useSearchTerms.mockReturnValue({
      isPending: false,
      error: null,
      data: [],
    });
    render(<SearchTermsPage />);

    expect(
      screen.getByText("No search terms in Germany for the selected window."),
    ).toBeInTheDocument();
  });

  it("shows the advertised book's cover next to the search term", () => {
    mocks.useBooks.mockReturnValue({
      data: [
        {
          id: "book-1",
          title: "Dragon Tales",
          coverImageUrl: "https://example.com/dragons.jpg",
        },
      ],
      isPending: false,
    });
    mocks.useSearchTerms.mockReturnValue({
      isPending: false,
      error: null,
      data: [searchTerm("dragons", { bookIds: ["book-1"] })],
    });

    render(<SearchTermsPage />);

    expect(
      screen.getByRole("img", { name: "Dragon Tales cover" }),
    ).toHaveAttribute("src", "https://example.com/dragons.jpg");
  });
});
