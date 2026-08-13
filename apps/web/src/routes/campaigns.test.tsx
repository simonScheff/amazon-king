import type { CampaignListRow } from "@amazon-king/contracts";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignsPage } from "./campaigns";

const mocks = vi.hoisted(() => ({
  useCampaigns: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));

vi.mock("../api/endpoints", () => ({
  useCampaigns: mocks.useCampaigns,
}));

function campaign(
  campaignId: string,
  name: string,
  overrides: Partial<CampaignListRow["profitability"]>,
  totals: CampaignListRow["totals"] = {
    impressions: 100,
    clicks: 10,
    cost: "8.0000",
    sales: "20.0000",
    orders: 2,
  },
): CampaignListRow {
  return {
    profileId: "profile-us",
    campaignId,
    name,
    state: "enabled",
    totals,
    profitability: {
      dateRange: { start: "2026-08-07", end: "2026-08-13" },
      currency: "USD",
      estimatedRoyalty: "10.0000",
      estimatedAdProfit: "2.0000",
      economicsMissing: false,
      dataCurrentThrough: "2026-08-13",
      ...overrides,
    },
  };
}

describe("CampaignsPage seven-day profitability", () => {
  beforeEach(() => {
    mocks.useCampaigns.mockReset();
    mocks.useCampaigns.mockReturnValue({
      isPending: false,
      error: null,
      data: [
        campaign("campaign-profit", "General", {}),
        campaign("campaign-loss", "Research", {
          estimatedRoyalty: "5.0000",
          estimatedAdProfit: "-3.0000",
        }),
        campaign("campaign-missing", "Discovery", {
          estimatedRoyalty: null,
          estimatedAdProfit: null,
          economicsMissing: true,
        }),
        campaign(
          "campaign-empty",
          "New campaign",
          {
            estimatedRoyalty: null,
            estimatedAdProfit: null,
          },
          {
            impressions: 0,
            clicks: 0,
            cost: "0",
            sales: "0",
            orders: 0,
          },
        ),
      ],
    });
  });

  it("shows the requested seven-day result for every campaign", () => {
    render(<CampaignsPage />);

    expect(mocks.useCampaigns).toHaveBeenCalledWith(7);
    expect(
      screen.getByRole("columnheader", { name: "7-day profit" }),
    ).toBeInTheDocument();

    const profitable = screen.getByLabelText(
      "General seven-day profit: Profitable",
    );
    expect(within(profitable).getByText("Profitable")).toBeInTheDocument();
    expect(within(profitable).getByText("$2.00")).toBeInTheDocument();

    const loss = screen.getByLabelText(
      "Research seven-day profit: Not profitable",
    );
    expect(within(loss).getByText("Not profitable")).toBeInTheDocument();
    expect(within(loss).getByText("-$3.00")).toBeInTheDocument();

    expect(
      within(
        screen.getByLabelText("Discovery seven-day profit: Profit unavailable"),
      ).getByText("Missing economics"),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByLabelText("New campaign seven-day profit: No activity"),
      ).getByText("—"),
    ).toBeInTheDocument();
  });
});
