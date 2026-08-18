import type { CampaignDetail } from "@amazon-king/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignDetailPage } from "./campaign-detail";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useCampaign: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => mocks.navigate,
  useParams: () => ({ id: "campaign-1" }),
  useSearch: () => ({ days: 7 }),
}));

vi.mock("../api/endpoints", () => ({
  useCampaign: mocks.useCampaign,
  useUpdateCampaignState: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useRenameCampaign: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  useProfiles: () => ({
    isPending: false,
    error: null,
    data: [
      {
        profileId: "profile-us",
        countryCode: "US",
        currencyCode: "USD",
      },
    ],
  }),
}));

vi.mock("../components/performance-trend-chart", () => ({
  PerformanceTrendChart: ({
    daily,
    showProfit,
  }: {
    daily: unknown[];
    showProfit: boolean;
  }) => (
    <div data-testid="campaign-chart">
      {daily.length} daily points · profit {showProfit ? "shown" : "hidden"}
    </div>
  ),
}));

vi.mock("../components/campaign-max-cpc", () => ({
  CampaignMaxCpc: () => <div>Max CPC controls</div>,
}));

vi.mock("../components/reauth-dialog", () => ({
  ReauthDialog: () => null,
}));

const detail: CampaignDetail = {
  dateRange: { start: "2026-08-07", end: "2026-08-13" },
  currency: "USD",
  campaign: {
    profileId: "profile-us",
    campaignId: "campaign-1",
    name: "General",
    state: "enabled",
    amazonConsoleUrl:
      "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
    totals: {
      impressions: 100,
      clicks: 10,
      cost: "8.0000",
      sales: "20.0000",
      orders: 2,
      acos: 0.4,
      estimatedRoyalty: "10.0000",
      estimatedAdProfit: "2.0000",
    },
  },
  economicsMissing: false,
  dataCurrentThrough: "2026-08-13T00:00:00.000Z",
  daily: [
    {
      date: "2026-08-12",
      cost: "5.0000",
      sales: "12.0000",
      estimatedRoyalty: "8.0000",
      estimatedAdProfit: "3.0000",
    },
    {
      date: "2026-08-13",
      cost: "3.0000",
      sales: "8.0000",
      estimatedRoyalty: "2.0000",
      estimatedAdProfit: "-1.0000",
    },
  ],
  adGroups: [],
  targets: [],
  searchTerms: [
    {
      id: "tractor gifts",
      name: "tractor gifts",
      state: "n/a",
      totals: {
        impressions: 9,
        clicks: 1,
        cost: "0.5000",
        sales: "8.3000",
        orders: 1,
      },
      estimatedRoyalty: "4.0000",
      estimatedAdProfit: "3.5000",
      economicsMissing: false,
    },
    {
      id: "farm tractors",
      name: "farm tractors",
      state: "n/a",
      totals: {
        impressions: 2,
        clicks: 1,
        cost: "0.5000",
        sales: "0.0000",
        orders: 0,
      },
      estimatedRoyalty: null,
      estimatedAdProfit: null,
      economicsMissing: true,
    },
  ],
  negativeKeywords: [
    {
      id: "negative-campaign",
      keywordText: "free books",
      matchType: "NEGATIVE_EXACT",
      level: "campaign",
      adGroupId: null,
      adGroupName: null,
      state: "ENABLED",
    },
    {
      id: "negative-ad-group",
      keywordText: "used books",
      matchType: "NEGATIVE_PHRASE",
      level: "ad_group",
      adGroupId: "ad-group-1",
      adGroupName: "Exact ad group",
      state: "PAUSED",
    },
  ],
};

describe("CampaignDetailPage profitability", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.useCampaign.mockReset();
    mocks.useCampaign.mockReturnValue({
      isPending: false,
      error: null,
      data: detail,
    });
  });

  it("shows campaign profit and a campaign-only daily chart", () => {
    render(<CampaignDetailPage />);

    expect(mocks.useCampaign).toHaveBeenCalledWith("campaign-1", 7, undefined);
    expect(screen.getByText("Profitable")).toBeInTheDocument();
    expect(screen.getByText("$2.00 estimated ad profit")).toBeInTheDocument();
    expect(screen.getByText("Est. ad profit")).toBeInTheDocument();
    expect(screen.getByTestId("campaign-chart")).toHaveTextContent(
      "2 daily points · profit shown",
    );
  });

  it("links to the campaign in the Amazon Ads console", () => {
    render(<CampaignDetailPage />);

    const link = screen.getByRole("link", { name: /Open in Amazon Ads/ });
    expect(link).toHaveAttribute(
      "href",
      "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("requests a different campaign window when the selector changes", () => {
    render(<CampaignDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "14d" }));

    const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
      to: string;
      params: { id: string };
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
      replace: boolean;
    };
    expect(call.to).toBe("/campaigns/$id");
    expect(call.params).toEqual({ id: "campaign-1" });
    expect(call.replace).toBe(true);
    // The functional search update keeps existing params (e.g. books).
    expect(call.search({ days: 7, books: ["3"] })).toEqual({
      days: 14,
      books: ["3"],
    });
  });

  it("requests month-to-date when the MTD selector is clicked", () => {
    render(<CampaignDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Month to date" }));

    const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({ days: 7, books: ["3"] })).toEqual({
      days: "mtd",
      books: ["3"],
    });
  });

  it("opens campaign-wide Max CPC controls from the breakdown tabs", () => {
    render(<CampaignDetailPage />);

    fireEvent.click(screen.getByRole("tab", { name: "Max CPC" }));

    expect(screen.getByText("Max CPC controls")).toBeInTheDocument();
  });

  it("shows every synced campaign and ad-group negative keyword", () => {
    render(<CampaignDetailPage />);

    fireEvent.click(screen.getByRole("tab", { name: "Negative keywords" }));

    expect(
      screen.getByRole("cell", { name: "free books" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Campaign" })).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "used books" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "Ad group · Exact ad group" }),
    ).toBeInTheDocument();
  });

  it("shows per-term profitability in the search terms tab", () => {
    render(<CampaignDetailPage />);

    fireEvent.click(screen.getByRole("tab", { name: "Search terms" }));

    expect(
      screen.getByRole("columnheader", { name: "Profit" }),
    ).toBeInTheDocument();
    const profitableRow = screen
      .getByRole("cell", { name: "tractor gifts" })
      .closest("tr");
    expect(profitableRow).toHaveTextContent("Profitable");
    expect(profitableRow).toHaveTextContent("$3.50");
    const missingRow = screen
      .getByRole("cell", { name: "farm tractors" })
      .closest("tr");
    expect(missingRow).toHaveTextContent("Profit unavailable");
    expect(missingRow).toHaveTextContent("Missing economics");
  });

  it("does not show a profit column on the other metric tabs", () => {
    render(<CampaignDetailPage />);

    expect(
      screen.queryByRole("columnheader", { name: "Profit" }),
    ).not.toBeInTheDocument();
  });
});
