import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Flag } from "./flag";

describe("Flag", () => {
  it("renders the bundled flag image for a country code", () => {
    render(<Flag countryCode="gb" />);

    expect(screen.getByRole("img", { name: "GB" })).toHaveClass("fi", "fi-gb");
  });

  it("maps Amazon's UK marketplace code to the bundled GB flag", () => {
    render(<Flag countryCode="UK" />);

    expect(screen.getByRole("img", { name: "UK" })).toHaveClass("fi", "fi-gb");
    expect(screen.getByRole("img", { name: "UK" })).not.toHaveClass("fi-uk");
  });

  it("renders nothing for a malformed country code", () => {
    const { container } = render(<Flag countryCode="g1" />);

    expect(container).toBeEmptyDOMElement();
  });
});
