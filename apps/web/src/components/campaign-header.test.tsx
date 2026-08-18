import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignHeader, type CampaignHeaderProps } from "./campaign-header";

const LONG_NAME = "Campaign - 12/07/2023 20:58:47.538";

function renderHeader(overrides: Partial<CampaignHeaderProps> = {}) {
  const onDaysChange = vi.fn();
  const props: CampaignHeaderProps = {
    name: LONG_NAME,
    state: "enabled",
    countryCode: "GB",
    currency: "GBP",
    profileId: "1665213640406890",
    amazonConsoleUrl:
      "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
    profitStatus: { label: "Not profitable", tone: "danger" },
    estimatedAdProfit: "-62.8400",
    hasActivity: true,
    dateRange: { start: "2026-06-20", end: "2026-08-18" },
    dataCurrentThrough: "2026-08-17T03:00:00.000Z",
    days: 60,
    onDaysChange,
    ...overrides,
  };
  render(<CampaignHeader {...props} />);
  return { onDaysChange };
}

describe("CampaignHeader", () => {
  afterEach(cleanup);

  it("keeps the full campaign name available on the truncated title", () => {
    renderHeader();

    const heading = screen.getByRole("heading", {
      name: new RegExp(LONG_NAME),
    });
    expect(within(heading).getByTitle(LONG_NAME)).toHaveClass("truncate");
    expect(within(heading).getByRole("img", { name: "GB" })).toHaveClass(
      "fi",
      "fi-gb",
    );
  });

  it("pairs the profit verdict with the amount in the toolbar", () => {
    renderHeader();

    expect(screen.getByText("Not profitable")).toBeInTheDocument();
    expect(screen.getByText("-£62.84")).toBeInTheDocument();
    expect(screen.getByText(/estimated ad profit/)).toBeInTheDocument();
  });

  it("falls back to the selected window when there is no activity", () => {
    renderHeader({
      hasActivity: false,
      estimatedAdProfit: null,
      profitStatus: { label: "No activity", tone: "neutral" },
    });

    expect(screen.getByText("Selected 60-day window")).toBeInTheDocument();
    expect(screen.queryByText("-£62.84")).not.toBeInTheDocument();
  });

  it("demotes the window, freshness, market, currency and profile id to small print", () => {
    renderHeader();

    const smallPrint = screen.getByText(/data through/);
    expect(smallPrint).toHaveTextContent("Jun 20, 2026 – Aug 18, 2026");
    expect(smallPrint).toHaveTextContent(/Aug 17, 2026/);
    expect(smallPrint).toHaveTextContent("United Kingdom");
    expect(smallPrint).toHaveTextContent("GBP");
    // Only the last four digits are shown; the full id stays in the tooltip.
    const profile = screen.getByTitle("1665213640406890");
    expect(profile).toHaveTextContent("Profile …6890");
    expect(profile).not.toHaveTextContent("1665213640406890");
  });

  it("reports timeframe changes and links to the Amazon console", () => {
    const { onDaysChange } = renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "14d" }));
    expect(onDaysChange).toHaveBeenCalledWith(14);

    const link = screen.getByRole("link", { name: /Open in Amazon Ads/ });
    expect(link).toHaveAttribute(
      "href",
      "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY-1",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders guarded controls in the toolbar", () => {
    renderHeader({ controls: <button type="button">Pause campaign</button> });

    expect(
      screen.getByRole("button", { name: "Pause campaign" }),
    ).toBeInTheDocument();
  });

  it("omits the Amazon link and the flag when they are unavailable", () => {
    renderHeader({ amazonConsoleUrl: null, countryCode: undefined });

    expect(
      screen.queryByRole("link", { name: /Open in Amazon Ads/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
