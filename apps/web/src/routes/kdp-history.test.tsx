import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KdpDailyProfit,
  KdpHistory,
  KdpSaleTransaction,
  KdpTransactionsPage,
} from "@amazon-king/contracts";
import { KdpHistoryPage, type KdpHistoryTab } from "./kdp-history";

const mocks = vi.hoisted(() => ({
  search: {} as { book?: string; tab?: KdpHistoryTab; month?: string },
  navigate: vi.fn(),
  history: undefined as KdpHistory | undefined,
  historyPending: false,
  transactions: { transactions: [], total: 0 } as KdpTransactionsPage,
  transactionFilters: [] as unknown[],
  dailyProfit: undefined as KdpDailyProfit | undefined,
  dailyProfitParams: [] as unknown[],
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
  useKdpDailyProfit: (params: unknown) => {
    mocks.dailyProfitParams.push(params);
    return { isPending: false, error: null, data: mocks.dailyProfit };
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

const DAILY_PROFIT: KdpDailyProfit = {
  start: "2026-08-01",
  end: "2026-08-31",
  currency: "USD",
  ratesAvailable: true,
  economicsMissing: false,
  kdpImported: true,
  daily: [
    {
      date: "2026-08-01",
      adSpend: "10.0000",
      adRoyalty: "6.8000",
      organicRoyalty: "1.2000",
      totalRoyalty: "8.0000",
      profit: "-2.0000",
    },
  ],
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
    mocks.dailyProfit = DAILY_PROFIT;
    mocks.dailyProfitParams = [];
  });

  it("lands on the organic data tab by default", () => {
    render(<KdpHistoryPage />);

    // The URL-backed tab bar lists all four sections.
    const nav = screen.getByRole("navigation", {
      name: "KDP history sections",
    });
    expect(nav).toBeInTheDocument();
    for (const label of [
      "Organic data",
      "Royalty trend",
      "Fulfillment",
      "Individual sales",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    // Organic tab content: one merged card — stat tiles over the visible
    // months plus the full-history sales-mix chart. Fixture sums: ad 37,
    // organic 17, total 54.
    expect(screen.getByText("Total sales — ads + organic")).toBeInTheDocument();
    expect(screen.getByText("Total units")).toBeInTheDocument();
    expect(screen.getByText("From ads")).toBeInTheDocument();
    expect(screen.getByText("Organic")).toBeInTheDocument();
    expect(screen.getByText("54")).toBeInTheDocument();
    expect(screen.getByText("37")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByLabelText("Sales mix by month")).toBeInTheDocument();

    // Other tabs' content stays unmounted.
    expect(
      screen.queryByText("Net royalty per sale — trend"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Fulfillment time")).not.toBeInTheDocument();
  });

  it("switches sections through the URL-backed tabs", () => {
    render(<KdpHistoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Individual sales" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/kdp-history",
      search: expect.any(Function),
      replace: true,
    });
    const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    // The book selection survives the tab switch.
    expect(call.search({ book: "book-2" })).toEqual({
      book: "book-2",
      tab: "transactions",
    });
  });

  it("shows the import prompt when nothing has been imported yet", () => {
    mocks.history = { series: [], fulfillment: [] };
    render(<KdpHistoryPage />);

    expect(screen.getByText(/No KDP sales history yet/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Settings → KDP imports" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "KDP history sections" }),
    ).not.toBeInTheDocument();
  });

  it("renders the royalty trend on its tab", () => {
    mocks.search = { tab: "royalty" };
    render(<KdpHistoryPage />);

    expect(
      screen.getByText("Net royalty per sale — trend"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Net royalty per sale trend"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sales mix by month")).not.toBeInTheDocument();
  });

  it("renders the fulfillment card on its tab", () => {
    mocks.search = { tab: "fulfillment" };
    render(<KdpHistoryPage />);

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
  });

  it("renders transaction rows with the fulfillment lag", () => {
    mocks.search = { tab: "transactions" };
    render(<KdpHistoryPage />);

    // The title also shows up in the book dropdowns; the row adds one more.
    expect(
      screen.getAllByText("Tractor Coloring Book").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("B0CV4BRP1G")).toBeInTheDocument();
    expect(screen.getByText("Amazon.com")).toBeInTheDocument();
    expect(screen.getByText("paperback")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getAllByText("$3.50").length).toBeGreaterThan(0);
    expect(screen.getByText("Aug 22, 2026")).toBeInTheDocument();
    expect(screen.getByText("3 days")).toBeInTheDocument();
  });

  it("passes the transaction filters to the query", () => {
    mocks.search = { tab: "transactions" };
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
    mocks.search = { tab: "transactions" };
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
    expect(call.search({ book: undefined })).toEqual({
      book: "book-2",
      tab: "organic",
    });
  });

  it("shows an empty transactions state when nothing matches", () => {
    mocks.search = { tab: "transactions" };
    mocks.transactions = { transactions: [], total: 0 };
    render(<KdpHistoryPage />);
    expect(
      screen.getByText("No sales match the current filters."),
    ).toBeInTheDocument();
  });

  it("renders the daily profit card on the organic tab", () => {
    render(<KdpHistoryPage />);

    expect(
      screen.getByText("Daily profit — ads + organic"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Daily profit chart")).toBeInTheDocument();
    expect(screen.getByLabelText("Daily profit month")).toBeInTheDocument();
    // All books selected: no book filter on the query.
    expect(mocks.dailyProfitParams.at(-1)).toEqual({
      month: expect.any(String),
      book: undefined,
    });
  });

  it("keeps the daily-profit month selector in the URL", () => {
    render(<KdpHistoryPage />);

    fireEvent.change(screen.getByLabelText("Daily profit month"), {
      target: { value: "2026-07-01" },
    });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/kdp-history",
      search: expect.any(Function),
      replace: true,
    });
    const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({})).toEqual({
      month: "2026-07-01",
      tab: "organic",
    });
  });

  it("honors the URL month and drives the card with the book selector", () => {
    mocks.search = { book: "book-2", month: "2026-07-01" };
    render(<KdpHistoryPage />);

    expect(mocks.dailyProfitParams.at(-1)).toEqual({
      month: "2026-07-01",
      book: "book-2",
    });
    expect(
      (screen.getByLabelText("Daily profit month") as HTMLSelectElement).value,
    ).toBe("2026-07-01");
  });

  it("notes when the selected month has no KDP import", () => {
    mocks.dailyProfit = {
      ...DAILY_PROFIT,
      kdpImported: false,
      daily: [
        {
          date: "2026-08-01",
          adSpend: "4.0000",
          adRoyalty: "0.0000",
          organicRoyalty: null,
          totalRoyalty: null,
          profit: null,
        },
      ],
    };
    render(<KdpHistoryPage />);

    expect(
      screen.getByText(/No KDP import for this month/),
    ).toBeInTheDocument();
  });
});
