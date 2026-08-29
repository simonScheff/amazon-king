import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KdpHistory,
  KdpSaleTransaction,
  KdpTransactionsPage,
} from "@amazon-king/contracts";
import { KdpHistoryPage } from "./kdp-history";

const mocks = vi.hoisted(() => ({
  search: {} as { book?: string },
  navigate: vi.fn(),
  history: undefined as KdpHistory | undefined,
  historyPending: false,
  transactions: { transactions: [], total: 0 } as KdpTransactionsPage,
  transactionFilters: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/endpoints", () => ({
  KDP_SALES_PAGE_SIZE: 50,
  useKdpHistory: () => ({
    isPending: mocks.historyPending,
    error: null,
    data: mocks.history,
  }),
  useKdpSaleTransactions: (filters: unknown) => {
    mocks.transactionFilters.push(filters);
    return { isPending: false, error: null, data: mocks.transactions };
  },
}));

const HISTORY: KdpHistory = {
  series: [
    {
      bookId: "book-1",
      title: "Tractor Coloring Book",
      profileId: "profile-us",
      countryCode: "US",
      currency: "USD",
      coverImageUrl: null,
      months: [
        {
          month: "2026-07-01",
          kdpStandardUnits: 12,
          kdpExpandedUnits: 2,
          adUnits: 9,
          royaltyPerSale: "3.4300",
        },
        {
          month: "2026-08-01",
          kdpStandardUnits: 15,
          kdpExpandedUnits: 1,
          adUnits: 11,
          royaltyPerSale: "3.5000",
        },
      ],
    },
    {
      bookId: "book-1",
      title: "Tractor Coloring Book",
      profileId: "profile-uk",
      countryCode: "GB",
      currency: "GBP",
      coverImageUrl: null,
      months: [
        {
          month: "2026-08-01",
          kdpStandardUnits: 4,
          kdpExpandedUnits: 0,
          adUnits: 3,
          royaltyPerSale: "2.8300",
        },
      ],
    },
    {
      bookId: "book-2",
      title: "Monster Truck Coloring Book",
      profileId: "profile-us",
      countryCode: "US",
      currency: "USD",
      coverImageUrl: null,
      months: [
        {
          month: "2026-08-01",
          kdpStandardUnits: 20,
          kdpExpandedUnits: 0,
          adUnits: 14,
          royaltyPerSale: "3.5000",
        },
      ],
    },
  ],
  fulfillment: [
    {
      profileId: "profile-us",
      countryCode: "US",
      months: [
        {
          month: "2026-07-01",
          medianDays: 3,
          averageDays: 3.2,
          standardUnits: 12,
        },
        {
          month: "2026-08-01",
          medianDays: 2,
          averageDays: 2.4,
          standardUnits: 15,
        },
      ],
    },
  ],
};

const SALE: KdpSaleTransaction = {
  id: "sale-1",
  bookId: "book-1",
  title: "Tractor Coloring Book",
  profileId: "profile-us",
  asin: "B0CV4BRP1G",
  marketplace: "Amazon.com",
  format: "paperback",
  royaltyType: "60%",
  transactionType: "Standard - Paperback",
  orderDate: "2026-08-22",
  royaltyDate: "2026-08-25",
  netUnits: 1,
  royalty: "3.5000",
  currency: "USD",
};

describe("KdpHistoryPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.search = {};
    mocks.navigate.mockReset();
    mocks.history = HISTORY;
    mocks.historyPending = false;
    mocks.transactions = { transactions: [SALE], total: 1 };
    mocks.transactionFilters = [];
  });

  it("renders all four sections from the history payload", () => {
    render(<KdpHistoryPage />);

    expect(
      screen.getByText("Net royalty per sale — trend"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Net royalty per sale trend"),
    ).toBeInTheDocument();
    expect(screen.getByText("Sales mix by month")).toBeInTheDocument();
    expect(screen.getByLabelText("Sales mix by month")).toBeInTheDocument();

    // Fulfillment: latest month's median/average for the marketplace. The
    // country name also appears in the filter dropdowns, hence getAllByText.
    expect(screen.getByText("Fulfillment time")).toBeInTheDocument();
    expect(screen.getAllByText("United States").length).toBeGreaterThan(0);
    expect(screen.getByText("2.0")).toBeInTheDocument();
    expect(screen.getByText("2.4")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Monthly median fulfillment time trend"),
    ).toBeInTheDocument();
    // Each bar exposes its exact values: an accessible label and a tooltip.
    expect(
      screen.getByLabelText("Aug 2026: median 2.0 days"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Median 2.0 d · avg 2.4 d · 15 sales"),
    ).toBeInTheDocument();

    expect(screen.getByText("Individual sales")).toBeInTheDocument();
  });

  it("shows the import prompt when nothing has been imported yet", () => {
    mocks.history = { series: [], fulfillment: [] };
    render(<KdpHistoryPage />);

    expect(screen.getByText(/No KDP sales history yet/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Settings → KDP imports" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Net royalty per sale trend"),
    ).not.toBeInTheDocument();
  });

  it("renders transaction rows with the fulfillment lag", () => {
    render(<KdpHistoryPage />);

    // The title also shows up in the book dropdowns; the row adds one more.
    expect(
      screen.getAllByText("Tractor Coloring Book").length,
    ).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("B0CV4BRP1G")).toBeInTheDocument();
    expect(screen.getByText("Amazon.com")).toBeInTheDocument();
    expect(screen.getByText("paperback")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    // The royalty also shows up in the trend stat tiles, hence getAllByText.
    expect(screen.getAllByText("$3.50").length).toBeGreaterThan(0);
    expect(screen.getByText("Aug 22, 2026")).toBeInTheDocument();
    expect(screen.getByText("3 days")).toBeInTheDocument();
  });

  it("passes the transaction filters to the query", () => {
    render(<KdpHistoryPage />);
    expect(mocks.transactionFilters.at(-1)).toEqual({
      bookId: undefined,
      profileId: undefined,
      month: undefined,
      page: 0,
    });

    fireEvent.change(screen.getByLabelText("Filter by book"), {
      target: { value: "book-1" },
    });
    expect(mocks.transactionFilters.at(-1)).toEqual(
      expect.objectContaining({ bookId: "book-1" }),
    );

    fireEvent.change(screen.getByLabelText("Filter by marketplace"), {
      target: { value: "profile-uk" },
    });
    expect(mocks.transactionFilters.at(-1)).toEqual(
      expect.objectContaining({ profileId: "profile-uk" }),
    );

    fireEvent.change(screen.getByLabelText("Filter by month"), {
      target: { value: "2026-08-01" },
    });
    expect(mocks.transactionFilters.at(-1)).toEqual({
      bookId: "book-1",
      profileId: "profile-uk",
      month: "2026-08-01",
      page: 0,
    });
  });

  it("paginates long transaction lists and resets the page on filter change", () => {
    mocks.transactions = { transactions: [SALE], total: 120 };
    render(<KdpHistoryPage />);

    // Footer: row range, page indicator, and a disabled Previous on page 1.
    expect(screen.getByText(/1–50 of 120/)).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.transactionFilters.at(-1)).toEqual(
      expect.objectContaining({ page: 1 }),
    );

    // A filter change starts over at the first page.
    fireEvent.change(screen.getByLabelText("Filter by month"), {
      target: { value: "2026-08-01" },
    });
    expect(mocks.transactionFilters.at(-1)).toEqual(
      expect.objectContaining({ page: 0 }),
    );
  });

  it("keeps the sales-mix book selector in the URL", () => {
    render(<KdpHistoryPage />);

    fireEvent.change(screen.getByLabelText("Sales mix book"), {
      target: { value: "book-2" },
    });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/kdp-history",
      search: expect.any(Function),
      replace: true,
    });
    const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({ book: undefined })).toEqual({ book: "book-2" });
  });

  it("shows an empty transactions state when nothing matches", () => {
    mocks.transactions = { transactions: [], total: 0 };
    render(<KdpHistoryPage />);
    expect(
      screen.getByText("No sales match the current filters."),
    ).toBeInTheDocument();
  });
});
