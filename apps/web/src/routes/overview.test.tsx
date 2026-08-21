import type {
  CountrySpend,
  FxRatesStatus,
  Recommendation,
} from "@amazon-king/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const fxUpToDate: FxRatesStatus = {
  latestRateDate: "2026-08-20",
  lastRunState: "succeeded",
  lastRunAt: "2026-08-20T17:01:00.000Z",
  lastError: null,
  stale: false,
};

const mocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  currency: "USD",
  ratesAvailable: true,
  fxRates: undefined as FxRatesStatus | undefined,
  countrySpend: undefined as CountrySpend | undefined,
  saveSettings: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
  useSearch: () => mocks.search,
}));

vi.mock("../api/endpoints", () => ({
  useAmazonStatus: () => ({ data: { status: "connected" } }),
  useDashboardSummary: () => ({
    isPending: false,
    error: null,
    data: {
      dateRange: { start: "2026-07-22", end: "2026-08-20" },
      currency: mocks.currency,
      ratesAvailable: mocks.ratesAvailable,
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
    data: { profiles: [], fxRates: mocks.fxRates },
  }),
  useSyncRuns: () => ({ data: [] }),
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
  useSearchTerms: () => ({ isPending: false, error: null, data: [] }),
  useCampaigns: () => ({ isPending: false, error: null, data: [] }),
  useBooks: () => ({ data: [] }),
  useCountrySpend: () => ({
    isPending: false,
    error: null,
    data: mocks.countrySpend,
  }),
  useUpdateWorkspaceSettings: () => ({
    isPending: false,
    mutate: mocks.saveSettings,
  }),
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

beforeEach(() => {
  mocks.search = {};
  mocks.currency = "USD";
  mocks.ratesAvailable = true;
  mocks.fxRates = fxUpToDate;
  mocks.countrySpend = undefined;
  mocks.saveSettings.mockReset();
});

afterEach(() => cleanup());

describe("OverviewPage pending recommendations", () => {
  it("shows when each pending finding was created", () => {
    render(<OverviewPage />);

    expect(
      screen.getByText(`Created ${formatDateTime(createdAt)}`),
    ).toBeInTheDocument();
  });
});

describe("OverviewPage FX rates row", () => {
  it("shows up-to-date rates with their coverage date", () => {
    render(<OverviewPage />);

    expect(screen.getByText("FX rates:")).toBeInTheDocument();
    expect(
      screen.getByText("up to date through Aug 20, 2026"),
    ).toBeInTheDocument();
  });

  it("warns when the stored rates are stale", () => {
    mocks.fxRates = {
      ...fxUpToDate,
      latestRateDate: "2026-08-14",
      stale: true,
    };
    render(<OverviewPage />);

    expect(
      screen.getByText("stale · rates through Aug 14, 2026"),
    ).toBeInTheDocument();
  });

  it("shows a truncated error when the last sync failed", () => {
    mocks.fxRates = {
      latestRateDate: "2026-08-19",
      lastRunState: "failed",
      lastRunAt: "2026-08-20T17:01:00.000Z",
      lastError: `Frankfurter rates request failed: ${"x".repeat(200)}`,
      stale: true,
    };
    render(<OverviewPage />);

    expect(screen.getByText("sync failed")).toBeInTheDocument();
    const error = screen.getByText(/Frankfurter rates request failed/);
    expect(error.textContent!.length).toBeLessThanOrEqual(141);
    expect(error.textContent).toMatch(/…$/);
  });

  it("shows syncing while a run is active", () => {
    mocks.fxRates = { ...fxUpToDate, lastRunState: "running" };
    render(<OverviewPage />);

    expect(screen.getByText("syncing…")).toBeInTheDocument();
  });

  it("shows not synced yet before the first run", () => {
    mocks.fxRates = {
      latestRateDate: null,
      lastRunState: "never_run",
      lastRunAt: null,
      lastError: null,
      stale: true,
    };
    render(<OverviewPage />);

    expect(screen.getByText("not synced yet")).toBeInTheDocument();
  });
});

describe("OverviewPage all-market view", () => {
  beforeEach(() => {
    mocks.search = { country: "all" };
    mocks.currency = "EUR";
  });

  it("renders All markets with figures in the display currency", () => {
    render(<OverviewPage />);

    const trigger = screen.getByRole("button", { name: "Country" });
    expect(trigger).toHaveTextContent("All markets");
    expect(trigger.querySelector(".fi")).toBeNull();
    expect(screen.getByText(/all figures in EUR/)).toBeInTheDocument();
    // KPI money is formatted in the display currency, not a market's.
    expect(screen.getAllByText("€0.00").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Display currency")).toBeInTheDocument();
  });

  it("lists per-market spend converted with the native amount secondary", () => {
    mocks.countrySpend = {
      dateRange: { start: "2026-07-22", end: "2026-08-20" },
      currency: "EUR",
      countries: [
        {
          countryCode: "US",
          currency: "USD",
          spend: "11.0000",
          convertedSpend: "10.0000",
        },
        {
          countryCode: "JP",
          currency: "JPY",
          spend: "1500.0000",
          convertedSpend: null,
        },
      ],
    };
    render(<OverviewPage />);

    expect(screen.getByText("Spend by market")).toBeInTheDocument();
    expect(screen.getByText("€10.00")).toBeInTheDocument();
    expect(screen.getByText("($11.00)")).toBeInTheDocument();
    // Rates do not cover this market: never a silently unconverted number.
    expect(screen.getByText("(rates missing)")).toBeInTheDocument();
  });

  it("saves a new display currency through the workspace settings mutation", () => {
    render(<OverviewPage />);

    fireEvent.change(screen.getByLabelText("Display currency"), {
      target: { value: "GBP" },
    });

    expect(mocks.saveSettings).toHaveBeenCalledWith(
      { displayCurrency: "GBP" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });
});

describe("OverviewPage all-markets gating", () => {
  it("disables the All markets option with an explanation when rates are unavailable", () => {
    mocks.ratesAvailable = false;
    render(<OverviewPage />);

    fireEvent.click(screen.getByRole("button", { name: "Country" }));
    const option = screen
      .getByRole("option", { name: /All markets/ })
      .querySelector("button")!;
    expect(option).toBeDisabled();
    expect(option).toHaveAttribute(
      "title",
      "Exchange rates not synced yet — see Sync status below",
    );
  });

  it("enables the All markets option when rates are available", () => {
    render(<OverviewPage />);

    fireEvent.click(screen.getByRole("button", { name: "Country" }));
    expect(
      screen
        .getByRole("option", { name: /All markets/ })
        .querySelector("button")!,
    ).toBeEnabled();
  });
});
