import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeframeSelect } from "./timeframe-select";

afterEach(cleanup);

describe("TimeframeSelect", () => {
  it("marks the current window and reports MTD", () => {
    const onChange = vi.fn();
    render(<TimeframeSelect value={30} onChange={onChange} />);

    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Month to date" }));
    expect(onChange).toHaveBeenCalledWith("mtd");
  });
});
