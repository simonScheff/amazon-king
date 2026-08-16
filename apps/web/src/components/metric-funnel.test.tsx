import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MetricFunnel } from "./metric-funnel";

describe("MetricFunnel", () => {
  afterEach(() => cleanup());

  it("renders each stage with its count and transition rates", () => {
    render(
      <MetricFunnel
        stages={[
          { label: "Impressions", value: 1000 },
          { label: "Clicks", value: 100, rateLabel: "CTR" },
          { label: "Orders", value: 5, rateLabel: "CVR" },
        ]}
      />,
    );

    expect(screen.getByLabelText("Conversion funnel")).toBeInTheDocument();
    expect(screen.getByText("Impressions")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(screen.getByText("CTR: 10.0%")).toBeInTheDocument();
    expect(screen.getByText("CVR: 5.0%")).toBeInTheDocument();
  });

  it("shows an empty state when the first stage has no volume", () => {
    render(
      <MetricFunnel
        stages={[
          { label: "Impressions", value: 0 },
          { label: "Clicks", value: 0, rateLabel: "CTR" },
        ]}
      />,
    );

    expect(
      screen.getByText("No funnel data in this window yet."),
    ).toBeInTheDocument();
  });

  it("marks the rate as unavailable when the previous stage is zero", () => {
    render(
      <MetricFunnel
        stages={[
          { label: "Impressions", value: 100 },
          { label: "Clicks", value: 0, rateLabel: "CTR" },
          { label: "Orders", value: 0, rateLabel: "CVR" },
        ]}
      />,
    );

    expect(screen.getByText("CTR: 0.0%")).toBeInTheDocument();
    expect(screen.getByText("CVR: —")).toBeInTheDocument();
  });
});
