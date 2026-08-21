import type {
  CampaignListRow,
  SearchTermListRow,
} from "@amazon-king/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopPerformers } from "./top-performers";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));

const totals = {
  impressions: 1000,
  clicks: 40,
  cost: "75.1000",
  sales: "412.6000",
  orders: 31,
  units: 31,
};

const searchTermRow: SearchTermListRow = {
  searchTerm: "dragon fantasy books",
  campaignCount: 2,
  countryCodes: ["US"],
  currency: "USD",
  totals: { ...totals, acos: 0.182 },
  estimatedRoyalty: "300.0000",
  estimatedAdProfit: "224.9000",
  economicsMissing: false,
  dataCurrentThrough: "2026-08-19",
  bookIds: ["book-1", "book-2"],
};

const campaignRow: CampaignListRow = {
  profileId: "profile-us",
  campaignId: "camp-1",
  name: "Emberfall — Auto | Discovery",
  state: "enabled",
  totals,
  amazonConsoleUrl: null,
  profitability: {
    dateRange: { start: "2026-07-22", end: "2026-08-20" },
    currency: "USD",
    estimatedRoyalty: "300.0000",
    estimatedAdProfit: "224.9000",
    economicsMissing: false,
    dataCurrentThrough: "2026-08-19",
  },
  bookIds: ["book-1"],
};

const mocks = vi.hoisted(() => ({
  searchTerms: {
    isPending: false,
    error: null as unknown,
    data: [] as unknown,
  },
  campaigns: { isPending: false, error: null as unknown, data: [] as unknown },
}));

vi.mock("../api/endpoints", () => ({
  useBooks: () => ({
    data: [
      { id: "book-1", title: "Emberfall", coverImageUrl: null },
      { id: "book-2", title: "Nightjar", coverImageUrl: null },
    ],
  }),
  useSearchTerms: () => mocks.searchTerms,
  useCampaigns: () => mocks.campaigns,
}));

function renderSection() {
  return render(
    <TopPerformers
      days={30}
      country="US"
      profileIds={new Set(["profile-us"])}
    />,
  );
}

describe("TopPerformers", () => {
  afterEach(() => cleanup());

  it("ranks search terms by estimated ad profit, not sales", () => {
    mocks.searchTerms = {
      isPending: false,
      error: null,
      data: [
        // Higher sales, much lower profit — must rank second.
        {
          ...searchTermRow,
          searchTerm: "big sales small margin",
          totals: { ...totals, sales: "999.0000", acos: 0.4 },
          estimatedAdProfit: "50.0000",
        },
        searchTermRow,
      ],
    };
    mocks.campaigns = { isPending: false, error: null, data: [campaignRow] };

    const { container } = renderSection();

    const termLinks = screen.getAllByRole("link").map((el) => el.textContent);
    expect(termLinks.indexOf("dragon fantasy books")).toBeLessThan(
      termLinks.indexOf("big sales small margin"),
    );
    // The headline number is profit (term + campaign fixtures share it).
    expect(screen.getAllByText("$224.90")).toHaveLength(2);
    // Profitable rows tint the ACoS green.
    const acosCells = screen.getAllByText("18.2% ACoS");
    expect(acosCells[0]?.className).toContain("text-emerald-300");
    // The leader's bar spans the full row.
    const bars = container.querySelectorAll("[aria-hidden='true'][style]");
    const widths = [...bars].map((el) => (el as HTMLElement).style.width);
    expect(widths).toContain("100%");
  });

  it("filters campaigns to the selected marketplace and drops rows without profit", () => {
    const losingCampaign: CampaignListRow = {
      ...campaignRow,
      campaignId: "camp-losing",
      name: "Losing campaign",
      profitability: {
        ...campaignRow.profitability,
        estimatedAdProfit: "-10.0000",
      },
    };
    const noEconomicsCampaign: CampaignListRow = {
      ...campaignRow,
      campaignId: "camp-noecon",
      name: "No economics campaign",
      profitability: {
        ...campaignRow.profitability,
        estimatedAdProfit: null,
        economicsMissing: true,
      },
    };
    const otherMarketCampaign: CampaignListRow = {
      ...campaignRow,
      profileId: "profile-uk",
      campaignId: "camp-uk",
      name: "UK only campaign",
    };
    mocks.searchTerms = { isPending: false, error: null, data: [] };
    mocks.campaigns = {
      isPending: false,
      error: null,
      data: [
        campaignRow,
        losingCampaign,
        noEconomicsCampaign,
        otherMarketCampaign,
      ],
    };

    renderSection();

    expect(
      screen.getByText("Emberfall — Auto | Discovery"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Losing campaign")).not.toBeInTheDocument();
    expect(screen.queryByText("No economics campaign")).not.toBeInTheDocument();
    expect(screen.queryByText("UK only campaign")).not.toBeInTheDocument();
  });

  it("shows an empty state per card when nothing was profitable", () => {
    mocks.searchTerms = { isPending: false, error: null, data: [] };
    mocks.campaigns = { isPending: false, error: null, data: [] };

    renderSection();

    expect(
      screen.getByText("No profitable search terms in this window."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No profitable campaigns in this window."),
    ).toBeInTheDocument();
  });

  it("points at book economics when sales exist but profit is unavailable", () => {
    mocks.searchTerms = {
      isPending: false,
      error: null,
      data: [
        {
          ...searchTermRow,
          estimatedAdProfit: null,
          estimatedRoyalty: null,
          economicsMissing: true,
        },
      ],
    };
    mocks.campaigns = {
      isPending: false,
      error: null,
      data: [
        {
          ...campaignRow,
          profitability: {
            ...campaignRow.profitability,
            estimatedAdProfit: null,
            estimatedRoyalty: null,
            economicsMissing: true,
          },
        },
      ],
    };

    renderSection();

    expect(
      screen.getAllByText(
        "Profit needs book economics — enter them under Settings → Book economics.",
      ),
    ).toHaveLength(2);
  });
});
