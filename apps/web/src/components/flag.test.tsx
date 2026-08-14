import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Flag } from "./flag";

describe("Flag", () => {
  it("renders the bundled flag image for a country code", () => {
    render(<Flag countryCode="gb" />);

    expect(screen.getByRole("img", { name: "GB" })).toHaveClass("fi", "fi-gb");
  });

  it("renders nothing for a malformed country code", () => {
    const { container } = render(<Flag countryCode="g1" />);

    expect(container).toBeEmptyDOMElement();
  });
});
