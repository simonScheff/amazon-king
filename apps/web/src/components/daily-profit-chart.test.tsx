import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  buildDailyProfitability,
  DailyProfitChart,
} from "./daily-profit-chart";

const makeDay = (
  date: string,
  cost: string,
  estimatedRoyalty: string | null,
) => ({ date, cost, sales: "0.0000", estimatedRoyalty });

describe("buildDailyProfitability", () => {
  it("derives daily profit as royalty minus spend and accumulates it", () => {
    const series = buildDailyProfitability([
      makeDay("2026-08-10", "5.0000", "10.0000"),
      makeDay("2026-08-11", "8.0000", "2.0000"),
      makeDay("2026-08-12", "1.0000", "4.0000"),
    ]);
    expect(series.map((point) => point.profit)).toEqual([5, -6, 3]);
    expect(series.map((point) => point.cumulative)).toEqual([5, -1, 2]);
  });

  it("prefers an API-provided profit over the derived value", () => {
    const series = buildDailyProfitability([
      {
        ...makeDay("2026-08-10", "5.0000", "10.0000"),
        estimatedAdProfit: "4.5000",
      },
    ]);
    expect(series[0]?.profit).toBe(4.5);
  });

  it("keeps profit null and carries cumulative forward without economics", () => {
    const series = buildDailyProfitability([
      makeDay("2026-08-10", "5.0000", "10.0000"),
      makeDay("2026-08-11", "4.0000", null),
      makeDay("2026-08-12", "1.0000", "3.0000"),
    ]);
    expect(series.map((point) => point.profit)).toEqual([5, null, 2]);
    expect(series.map((point) => point.cumulative)).toEqual([5, 5, 7]);
  });
});

describe("DailyProfitChart", () => {
  it("shows an empty state when there is no daily data", () => {
    render(<DailyProfitChart daily={[]} currency="USD" />);
    expect(
      screen.getByText("No daily trend data available yet."),
    ).toBeInTheDocument();
  });

  it("renders the chart container when data exists", () => {
    render(
      <DailyProfitChart
        currency="USD"
        daily={[makeDay("2026-08-10", "5.0000", "10.0000")]}
      />,
    );
    expect(screen.getByLabelText("Daily profit chart")).toBeInTheDocument();
  });
});
