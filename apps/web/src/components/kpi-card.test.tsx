import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("renders as a pressed toggle button with a swatch when active", () => {
    const onToggle = vi.fn();
    render(
      <KpiCard
        label="Spend"
        value="$123.00"
        swatch="#f59e0b"
        active
        onToggle={onToggle}
      />,
    );
    const button = screen.getByRole("button", { name: /Spend/ });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders a muted suffix on the same row as the value", () => {
    render(
      <KpiCard
        label="Orders"
        value="33"
        suffix="48 units"
        suffixTitle="hint"
      />,
    );
    const suffix = screen.getByText("48 units");
    expect(suffix).toHaveAttribute("title", "hint");
    expect(suffix.parentElement).toHaveTextContent("3348 units");
  });

  it("reflects the inactive state when the series is hidden", () => {
    render(
      <KpiCard
        label="ACoS"
        value="41.2%"
        swatch="#f472b6"
        active={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /ACoS/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
