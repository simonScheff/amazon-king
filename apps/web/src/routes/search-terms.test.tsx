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
  useBooks: vi.fn(),
  useSearch: vi.fn(() => ({}) as { book?: string }),
  useNavigate: vi.fn(() => vi.fn()),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useSearch: mocks.useSearch,
  useNavigate: mocks.useNavigate,
}));

vi.mock("../api/endpoints", () => ({
  useSearchTerms: mocks.useSearchTerms,
  useBooks: mocks.useBooks,
}));

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
      acos: 0.4,
    },
    estimatedRoyalty: "10.0000",
    estimatedAdProfit: "2.0000",
    economicsMissing: false,
    dataCurrentThrough: "2026-08-13",
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
    mocks.useBooks.mockReturnValue({
      data: [
        { id: "book-1", asin: "B001", title: "First title", format: "ebook" },
      ],
    });
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

  it("shows the seven-day result for every aggregated search term", () => {
    render(<SearchTermsPage />);

    expect(mocks.useSearchTerms).toHaveBeenCalledWith(7, undefined);
    expect(
      screen.getByRole("columnheader", { name: "7-day profit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Campaigns" }),
    ).toBeInTheDocument();

    const profitable = screen.getByLabelText(
      "fantasy books seven-day profit: Profitable",
    );
    expect(within(profitable).getByText("Profitable")).toBeInTheDocument();
    expect(within(profitable).getByText("$2.00")).toBeInTheDocument();

    const loss = screen.getByLabelText(
      "dragons seven-day profit: Not profitable",
    );
    expect(within(loss).getByText("Not profitable")).toBeInTheDocument();
    expect(within(loss).getByText("-$3.00")).toBeInTheDocument();

    expect(
      within(
        screen.getByLabelText(
          "unmapped series seven-day profit: Profit unavailable",
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
        }),
        searchTerm("alpha", {
          totals: { ...searchTerm("alpha").totals, orders: 1 },
        }),
        searchTerm("gamma", {
          totals: { ...searchTerm("gamma").totals, orders: 2 },
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

  it("passes the selected product to the query and keeps it on drill-down", () => {
    const navigate = vi.fn();
    mocks.useNavigate.mockReturnValue(navigate);
    mocks.useSearch.mockReturnValue({ book: "book-1" });
    render(<SearchTermsPage />);

    expect(mocks.useSearchTerms).toHaveBeenCalledWith(7, "book-1");

    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("book-1");

    fireEvent.change(select, { target: { value: "" } });
    expect(navigate).toHaveBeenCalledWith({
      to: "/search-terms",
      search: {},
      replace: true,
    });
  });
});
