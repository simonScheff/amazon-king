import type { SearchTermDetail } from "@amazon-king/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchTermDetailPage } from "./search-term-detail";

const mocks = vi.hoisted(() => ({
  useSearchTerm: vi.fn(),
  useProfiles: vi.fn(),
  useSearch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useParams: () => ({ term: "fantasy books" }),
  useSearch: mocks.useSearch,
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/endpoints", () => ({
  useSearchTerm: mocks.useSearchTerm,
  useProfiles: mocks.useProfiles,
}));

function detail(campaigns: SearchTermDetail["campaigns"]): SearchTermDetail {
  const orders = campaigns.reduce((sum, c) => sum + c.totals.orders, 0);
  const economicsMissing = campaigns.some((c) => c.economicsMissing);
  return {
    searchTerm: "fantasy books",
    countryCode: "US",
    availableCountryCodes: ["US"],
    dateRange: { start: "2026-08-07", end: "2026-08-13" },
    currency: "USD",
    totals: {
      impressions: 100,
      clicks: 10,
      cost: "8.0000",
      sales: "20.0000",
      orders,
      acos: 0.4,
      estimatedRoyalty: economicsMissing ? null : "10.0000",
      estimatedAdProfit: economicsMissing ? null : "2.0000",
    },
    economicsMissing,
    dataCurrentThrough: "2026-08-13",
    daily: [
      {
        date: "2026-08-12",
        cost: "3.0000",
        sales: "8.0000",
        estimatedRoyalty: economicsMissing ? null : "4.0000",
        estimatedAdProfit: economicsMissing ? null : "1.0000",
      },
      {
        date: "2026-08-13",
        cost: "5.0000",
        sales: "12.0000",
        estimatedRoyalty: economicsMissing ? null : "6.0000",
        estimatedAdProfit: economicsMissing ? null : "1.0000",
      },
    ],
    campaigns,
  };
}

function campaign(
  campaignId: string,
  name: string,
  overrides: Partial<SearchTermDetail["campaigns"][number]> = {},
): SearchTermDetail["campaigns"][number] {
  return {
    profileId: "profile-us",
    campaignId,
    name,
    state: "enabled",
    totals: {
      impressions: 60,
      clicks: 6,
      cost: "5.0000",
      sales: "12.0000",
      orders: 1,
    },
    estimatedRoyalty: "6.0000",
    estimatedAdProfit: "1.0000",
    economicsMissing: false,
    ...overrides,
  };
}

describe("SearchTermDetailPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.useSearchTerm.mockReset();
    mocks.useProfiles.mockReset();
    mocks.useProfiles.mockReturnValue({ isPending: false, data: [] });
    mocks.useSearch.mockReset();
    mocks.useSearch.mockReturnValue({ days: 7 });
    mocks.navigate.mockReset();
    mocks.useSearchTerm.mockReturnValue({
      isPending: false,
      error: null,
      data: detail([
        campaign("campaign-1", "General"),
        campaign("campaign-2", "Research", {
          estimatedRoyalty: "4.0000",
          estimatedAdProfit: "-1.0000",
        }),
      ]),
    });
  });

  it("lists every campaign advertising the search term", () => {
    render(<SearchTermDetailPage />);

    expect(mocks.useSearchTerm).toHaveBeenCalledWith(
      "fantasy books",
      7,
      undefined,
      undefined,
    );
    expect(
      screen.getByRole("heading", { name: "fantasy books" }),
    ).toBeInTheDocument();

    const general = screen.getByLabelText("General 7-day profit: Profitable");
    expect(within(general).getByText("Profitable")).toBeInTheDocument();
    expect(within(general).getByText("$1.00")).toBeInTheDocument();

    const research = screen.getByLabelText(
      "Research 7-day profit: Not profitable",
    );
    expect(within(research).getByText("Not profitable")).toBeInTheDocument();
    expect(within(research).getByText("-$1.00")).toBeInTheDocument();
  });

  it("renders the daily performance trend chart", () => {
    render(<SearchTermDetailPage />);

    expect(
      screen.getByRole("heading", { name: "Daily performance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Daily performance trend"),
    ).toBeInTheDocument();
  });

  it("renders the conversion funnel with CTR and CVR", () => {
    render(<SearchTermDetailPage />);

    expect(
      screen.getByRole("heading", { name: "7-day conversion funnel" }),
    ).toBeInTheDocument();
    const funnel = screen.getByLabelText("Conversion funnel");
    expect(within(funnel).getByText("CTR: 10.0%")).toBeInTheDocument();
    expect(within(funnel).getByText("CVR: 20.0%")).toBeInTheDocument();
  });

  it("switches between only the markets where the term has data", () => {
    const data = detail([campaign("campaign-1", "General")]);
    data.availableCountryCodes = ["US", "GB"];
    mocks.useSearchTerm.mockReturnValue({
      isPending: false,
      error: null,
      data,
    });

    render(<SearchTermDetailPage />);

    const market = screen.getByRole("combobox", { name: "Market" });
    expect(within(market).getAllByRole("option")).toHaveLength(2);
    expect(market).toHaveValue("US");

    fireEvent.change(market, { target: { value: "GB" } });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/search-terms/$term",
      params: { term: "fantasy books" },
      search: { days: 7, country: "GB" },
      replace: true,
    });
  });

  it("opens the campaign wizard prefilled when copying to another market", () => {
    mocks.useProfiles.mockReturnValue({
      isPending: false,
      data: [
        {
          profileId: "profile-us",
          countryCode: "US",
          currencyCode: "USD",
          enabled: true,
        },
        {
          profileId: "profile-gb",
          countryCode: "GB",
          currencyCode: "GBP",
          enabled: true,
        },
        {
          profileId: "profile-de",
          countryCode: "DE",
          currencyCode: "EUR",
          enabled: false,
        },
      ],
    });

    render(<SearchTermDetailPage />);

    const copy = screen.getByRole("combobox", { name: "Copy to market" });
    // The current market (US) and disabled profiles (DE) are not offered.
    expect(
      within(copy)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose…", "United Kingdom (GB)"]);

    fireEvent.change(copy, { target: { value: "GB" } });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/campaigns/new",
      search: { searchTerm: "fantasy books", country: "GB" },
    });
  });

  it("hides the copy control when no other enabled market exists", () => {
    render(<SearchTermDetailPage />);

    expect(
      screen.queryByRole("combobox", { name: "Copy to market" }),
    ).not.toBeInTheDocument();
  });

  it("warns when profit is hidden because economics are missing", () => {
    mocks.useSearchTerm.mockReturnValue({
      isPending: false,
      error: null,
      data: detail([
        campaign("campaign-1", "General"),
        campaign("campaign-2", "Research", {
          estimatedRoyalty: null,
          estimatedAdProfit: null,
          economicsMissing: true,
        }),
      ]),
    });

    render(<SearchTermDetailPage />);

    expect(
      screen.getByText(/Profit is hidden because one or more advertised books/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Research 7-day profit: Profit unavailable"),
    ).toBeInTheDocument();
  });

  it("sorts the advertising campaigns when a column header is clicked", () => {
    mocks.useSearchTerm.mockReturnValue({
      isPending: false,
      error: null,
      data: detail([
        campaign("campaign-1", "General"),
        campaign("campaign-2", "Research", {
          totals: {
            impressions: 40,
            clicks: 4,
            cost: "9.0000",
            sales: "8.0000",
            orders: 3,
          },
          estimatedRoyalty: "4.0000",
          estimatedAdProfit: "-5.0000",
        }),
      ]),
    });
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("td a")?.textContent ?? "");

    render(<SearchTermDetailPage />);

    // Default: spend desc → Research (9) before General (5).
    expect(rowNames()).toEqual(["Research", "General"]);

    fireEvent.click(screen.getByRole("button", { name: /Campaign/ }));
    expect(rowNames()).toEqual(["General", "Research"]);

    fireEvent.click(screen.getByRole("button", { name: /Orders/ }));
    expect(rowNames()).toEqual(["Research", "General"]);
  });
});
