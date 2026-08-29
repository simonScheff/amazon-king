import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { KdpHistorySeries } from "@amazon-king/contracts";
import {
  buildRoyaltyTrend,
  buildSalesMix,
  buildSalesTotals,
  currentMonth,
  RoyaltyTrendChart,
  SalesMixChart,
  unitShare,
} from "./kdp-history-charts";

function series(
  overrides: Partial<KdpHistorySeries> & Pick<KdpHistorySeries, "bookId">,
): KdpHistorySeries {
  return {
    title: "Tractor Coloring Book",
    profileId: "profile-us",
    countryCode: "US",
    currency: "USD",
    coverImageUrl: null,
    months: [
      {
        month: "2026-07-01",
        kdpStandardUnits: 10,
        kdpExpandedUnits: 2,
        adUnits: 8,
        royaltyPerSale: "3.4300",
      },
    ],
    ...overrides,
  };
}

describe("buildRoyaltyTrend", () => {
  it("labels each line with title, country, and currency", () => {
    const { lines } = buildRoyaltyTrend([
      series({ bookId: "book-1" }),
      series({
        bookId: "book-1",
        profileId: "profile-uk",
        countryCode: "GB",
        currency: "GBP",
      }),
    ]);
    expect(lines.map((line) => line.name)).toEqual([
      "Tractor Coloring Book (US · USD)",
      "Tractor Coloring Book (GB · GBP)",
    ]);
  });

  it("aligns months across series and leaves gaps null", () => {
    const { data, lines } = buildRoyaltyTrend([
      series({ bookId: "book-1" }),
      series({
        bookId: "book-2",
        title: "Monster Truck Coloring Book",
        months: [
          {
            month: "2026-08-01",
            kdpStandardUnits: 5,
            kdpExpandedUnits: 0,
            adUnits: 4,
            royaltyPerSale: "3.5000",
          },
        ],
      }),
    ]);
    expect(data.map((point) => point.month)).toEqual([
      "2026-07-01",
      "2026-08-01",
    ]);
    const [first, second] = lines;
    expect(data[0]?.[first!.key]).toBe(3.43);
    expect(data[0]?.[second!.key]).toBeNull();
    expect(data[1]?.[second!.key]).toBe(3.5);
  });
});

describe("buildSalesMix", () => {
  it("splits KDP units into ad-attributed and organic per month", () => {
    const data = buildSalesMix([series({ bookId: "book-1" })]);
    expect(data).toEqual([{ month: "2026-07-01", ad: 8, organic: 4 }]);
  });

  it("clamps organic at zero when ad attribution exceeds KDP units", () => {
    const data = buildSalesMix([
      series({
        bookId: "book-1",
        months: [
          {
            month: "2026-07-01",
            kdpStandardUnits: 3,
            kdpExpandedUnits: 1,
            adUnits: 9,
            royaltyPerSale: null,
          },
        ],
      }),
    ]);
    expect(data[0]).toEqual({ month: "2026-07-01", ad: 9, organic: 0 });
  });

  it("sums units across series for the all-books view", () => {
    const data = buildSalesMix([
      series({ bookId: "book-1" }),
      series({ bookId: "book-2", title: "Other Book" }),
    ]);
    expect(data).toEqual([{ month: "2026-07-01", ad: 16, organic: 8 }]);
  });
});

describe("buildSalesTotals", () => {
  it("sums ad and organic units over the visible months", () => {
    expect(
      buildSalesTotals([
        { month: "2026-07-01", ad: 8, organic: 4 },
        { month: "2026-08-01", ad: 10, organic: 6 },
      ]),
    ).toEqual({ total: 28, ad: 18, organic: 10 });
  });
});

describe("unitShare", () => {
  it("returns the fraction of the total, null without a base", () => {
    expect(unitShare(18, 28)).toBeCloseTo(18 / 28);
    expect(unitShare(0, 0)).toBeNull();
  });
});

describe("currentMonth", () => {
  it("is the first-of-month ISO date of the given instant (UTC)", () => {
    expect(currentMonth(new Date("2026-08-29T10:00:00Z"))).toBe("2026-08-01");
  });
});

describe("charts", () => {
  it("renders the royalty trend container from data", () => {
    render(<RoyaltyTrendChart series={[series({ bookId: "book-1" })]} />);
    expect(
      screen.getByLabelText("Net royalty per sale trend"),
    ).toBeInTheDocument();
  });

  it("renders the sales mix container from data", () => {
    render(<SalesMixChart series={[series({ bookId: "book-1" })]} />);
    expect(screen.getByLabelText("Sales mix by month")).toBeInTheDocument();
  });

  it("shows an empty state without history", () => {
    render(<RoyaltyTrendChart series={[]} />);
    expect(screen.getByText("No royalty history yet.")).toBeInTheDocument();
  });
});
