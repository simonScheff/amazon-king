import type { Recommendation } from "@amazon-king/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "../lib/format";
import { OverviewPage } from "./overview";

const createdAt = "2026-08-13T02:01:00.000Z";

const recommendation: Recommendation = {
  id: "rec-1",
  type: "cannibalization_conflict",
  state: "pending",
  priority: 2,
  profileId: "profile-us",
  campaignId: null,
  campaign: null,
  adGroupId: null,
  targetId: null,
  searchTerm: "tractor colouring book",
  currentValue: null,
  proposedValue: null,
  rationale: "The same term is spending in two campaigns.",
  confidence: 0.5,
  evidenceWindow: { start: "2026-06-14", end: "2026-08-12" },
  dataFreshness: "2026-08-13T02:01:00.000Z",
  ruleVersion: "cannibalization_conflict@2",
  expiresAt: "2026-08-16T02:01:00.000Z",
  createdAt,
};

const emptyTotals = {
  impressions: 0,
  clicks: 0,
  cost: "0.0000",
  sales: "0.0000",
  orders: 0,
  units: 0,
  acos: null,
  estimatedRoyalty: null,
  estimatedAdProfit: null,
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

vi.mock("../api/endpoints", () => ({
  useAmazonStatus: () => ({ data: { status: "connected" } }),
  useDashboardSummary: () => ({
    isPending: false,
    error: null,
    data: {
      dateRange: { start: "2026-07-22", end: "2026-08-20" },
      currency: "USD",
      totals: emptyTotals,
      previous: {
        dateRange: { start: "2026-06-22", end: "2026-07-21" },
        totals: emptyTotals,
      },
      economicsMissing: true,
      dataCurrentThrough: "2026-08-20T12:00:00.000Z",
      daily: [],
    },
  }),
  useDataFreshness: () => ({
    isPending: false,
    error: null,
    data: [],
  }),
  useProfiles: () => ({
    isPending: false,
    error: null,
    data: [
      {
        profileId: "profile-us",
        accountId: "account-1",
        region: "NA",
        countryCode: "US",
        currencyCode: "USD",
        timezone: null,
        accountType: null,
        enabled: true,
        writeEnabled: false,
      },
    ],
  }),
  useRecommendations: () => ({
    isPending: false,
    error: null,
    data: [recommendation],
  }),
  useCountrySpend: () => ({ data: undefined }),
}));

vi.mock("../components/performance-trend-chart", () => ({
  PerformanceTrendChart: () => <div data-testid="trend-chart" />,
  TREND_SERIES_COLORS: {
    spend: "#fff",
    sales: "#fff",
    royalty: "#fff",
    orders: "#fff",
    acos: "#fff",
    profit: "#fff",
  },
}));

describe("OverviewPage pending recommendations", () => {
  afterEach(() => cleanup());

  it("shows when each pending finding was created", () => {
    render(<OverviewPage />);

    expect(
      screen.getByText(`Created ${formatDateTime(createdAt)}`),
    ).toBeInTheDocument();
  });
});
