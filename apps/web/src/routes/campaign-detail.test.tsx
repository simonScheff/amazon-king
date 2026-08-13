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

const detail: CampaignDetail = {
  dateRange: { start: "2026-08-07", end: "2026-08-13" },
  currency: "USD",
  campaign: {
    profileId: "profile-us",
    campaignId: "campaign-1",
    name: "General",
    state: "enabled",
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
  searchTerms: [],
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

    expect(mocks.useCampaign).toHaveBeenCalledWith("campaign-1", 7);
    expect(screen.getByText("Profitable")).toBeInTheDocument();
    expect(screen.getByText("$2.00 estimated ad profit")).toBeInTheDocument();
    expect(screen.getByText("Est. ad profit")).toBeInTheDocument();
    expect(screen.getByTestId("campaign-chart")).toHaveTextContent(
      "2 daily points · profit shown",
    );
  });

  it("requests a different campaign window when the selector changes", () => {
    render(<CampaignDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "14d" }));

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/campaigns/$id",
      params: { id: "campaign-1" },
      search: { days: 14 },
      replace: true,
    });
  });
});
