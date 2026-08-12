import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiCard } from "./kpi-card";

describe("KpiCard", () => {
  it("renders label and value", () => {
    render(<KpiCard label="Spend" value="$123.00" />);
    expect(screen.getByText("Spend")).toBeInTheDocument();
    expect(screen.getByText("$123.00")).toBeInTheDocument();
  });

  it("renders the economics-missing state instead of the value", () => {
    render(<KpiCard label="Est. ad profit" value="$45.00" missing />);
    expect(screen.getByText("economics missing")).toBeInTheDocument();
    expect(screen.queryByText("$45.00")).not.toBeInTheDocument();
  });
});
