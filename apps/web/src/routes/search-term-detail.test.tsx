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
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useParams: () => ({ term: "fantasy books" }),
  useSearch: () => ({ days: 7 }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../api/endpoints", () => ({
  useSearchTerm: mocks.useSearchTerm,
}));

function detail(campaigns: SearchTermDetail["campaigns"]): SearchTermDetail {
  const orders = campaigns.reduce((sum, c) => sum + c.totals.orders, 0);
  const economicsMissing = campaigns.some((c) => c.economicsMissing);
  return {
    searchTerm: "fantasy books",
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
