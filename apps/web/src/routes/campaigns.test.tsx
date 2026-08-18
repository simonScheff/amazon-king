import type { CampaignListRow } from "@amazon-king/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignsPage } from "./campaigns";

const mocks = vi.hoisted(() => ({
  useCampaigns: vi.fn(),
  useProfiles: vi.fn(),
  useBooks: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useSearch: () => ({}) as { books?: string[] },
}));

vi.mock("../api/endpoints", () => ({
  useCampaigns: mocks.useCampaigns,
  useProfiles: mocks.useProfiles,
  useBooks: mocks.useBooks,
  useCountrySpend: () => ({ data: undefined }),
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
  bookIds: string[] = [],
): CampaignListRow {
  return {
    profileId: "profile-us",
    campaignId,
    name,
    state: "enabled",
    amazonConsoleUrl:
      "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
    totals,
    bookIds,
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
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.useCampaigns.mockReset();
    mocks.useProfiles.mockReset();
    mocks.useBooks.mockReset();
    mocks.useBooks.mockReturnValue({ data: [], isPending: false });
    mocks.useProfiles.mockReturnValue({
      data: [
        {
          profileId: "profile-us",
          accountId: "account-1",
          region: "NA",
          countryCode: "US",
          currencyCode: "USD",
          timezone: "America/Los_Angeles",
          accountType: "seller",
          enabled: true,
          writeEnabled: false,
        },
      ],
    });
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

    expect(mocks.useCampaigns).toHaveBeenCalledWith(7, undefined);
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

  it("shows the market flag of each campaign's profile", () => {
    render(<CampaignsPage />);

    const markets = screen.getAllByTitle("United States · profile profile-us");
    expect(markets).toHaveLength(4);
    expect(markets[0]).toHaveTextContent("US");
    expect(markets[0]!.querySelector(".fi.fi-us")).not.toBeNull();
  });

  it("filters campaigns by market", () => {
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("td a")?.textContent ?? "");

    mocks.useProfiles.mockReturnValue({
      data: [
        {
          profileId: "profile-us",
          accountId: "account-1",
          region: "NA",
          countryCode: "US",
          currencyCode: "USD",
          timezone: "America/Los_Angeles",
          accountType: "seller",
          enabled: true,
          writeEnabled: false,
        },
        {
          profileId: "profile-gb",
          accountId: "account-1",
          region: "EU",
          countryCode: "GB",
          currencyCode: "GBP",
          timezone: "Europe/London",
          accountType: "seller",
          enabled: true,
          writeEnabled: false,
        },
      ],
    });
    mocks.useCampaigns.mockReturnValue({
      isPending: false,
      error: null,
      data: [
        campaign("campaign-us", "US campaign", {}),
        {
          ...campaign("campaign-gb", "GB campaign", {}),
          profileId: "profile-gb",
        },
      ],
    });

    render(<CampaignsPage />);
    expect(rowNames()).toHaveLength(2);

    const marketFilter = screen.getByRole("button", {
      name: "Filter by market",
    });
    expect(marketFilter).toHaveTextContent("All markets");

    fireEvent.click(marketFilter);
    fireEvent.click(
      screen
        .getByRole("option", { name: /United Kingdom/ })
        .querySelector("button")!,
    );
    expect(rowNames()).toEqual(["GB campaign"]);

    fireEvent.click(marketFilter);
    fireEvent.click(
      screen
        .getByRole("option", { name: /United States/ })
        .querySelector("button")!,
    );
    expect(rowNames()).toEqual(["US campaign"]);

    fireEvent.click(marketFilter);
    fireEvent.click(
      screen
        .getByRole("option", { name: "All markets" })
        .querySelector("button")!,
    );
    expect(rowNames()).toHaveLength(2);
  });

  it("shows an empty state when the market has no campaigns", () => {
    mocks.useProfiles.mockReturnValue({
      data: [
        {
          profileId: "profile-us",
          accountId: "account-1",
          region: "NA",
          countryCode: "US",
          currencyCode: "USD",
          timezone: "America/Los_Angeles",
          accountType: "seller",
          enabled: true,
          writeEnabled: false,
        },
        {
          profileId: "profile-de",
          accountId: "account-1",
          region: "EU",
          countryCode: "DE",
          currencyCode: "EUR",
          timezone: "Europe/Berlin",
          accountType: "seller",
          enabled: true,
          writeEnabled: false,
        },
      ],
    });

    render(<CampaignsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by market" }));
    fireEvent.click(
      screen.getByRole("option", { name: /Germany/ }).querySelector("button")!,
    );
    expect(screen.getByText("No campaigns in Germany.")).toBeInTheDocument();
  });

  it("filters campaigns by the search box", () => {
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("td a")?.textContent ?? "");

    render(<CampaignsPage />);
    expect(rowNames()).toHaveLength(4);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "RESEARCH" },
    });
    expect(rowNames()).toEqual(["Research"]);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No campaigns match “zzz”.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(rowNames()).toHaveLength(4);
  });

  it("sorts rows when a column header is clicked", () => {
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("td a")?.textContent ?? "");

    render(<CampaignsPage />);

    // Default: spend desc (ties keep their seeded order; idle campaign last).
    expect(rowNames()).toEqual([
      "General",
      "Research",
      "Discovery",
      "New campaign",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Campaign/ }));
    expect(rowNames()).toEqual([
      "Discovery",
      "General",
      "New campaign",
      "Research",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Campaign/ }));
    expect(rowNames()).toEqual([
      "Research",
      "New campaign",
      "General",
      "Discovery",
    ]);

    // Profit desc: unavailable profit (Discovery, New campaign) sorts last.
    fireEvent.click(screen.getByRole("button", { name: /7-day profit/ }));
    expect(rowNames()).toEqual([
      "General",
      "Research",
      "Discovery",
      "New campaign",
    ]);
  });

  it("shows the advertised book's cover next to the campaign name", () => {
    mocks.useBooks.mockReturnValue({
      data: [
        {
          id: "book-1",
          title: "Farm Tractors",
          coverImageUrl: "https://example.com/tractors.jpg",
        },
      ],
      isPending: false,
    });
    mocks.useCampaigns.mockReturnValue({
      isPending: false,
      error: null,
      data: [campaign("campaign-profit", "General", {}, undefined, ["book-1"])],
    });

    render(<CampaignsPage />);

    expect(
      screen.getByRole("img", { name: "Farm Tractors cover" }),
    ).toHaveAttribute("src", "https://example.com/tractors.jpg");
  });
});
