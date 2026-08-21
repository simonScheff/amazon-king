import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CountrySelect } from "./country-select";

const options = [
  {
    countryCode: "US",
    countryName: "United States",
    currencyCodes: ["USD"],
    profileIds: ["US-USD"],
  },
  {
    countryCode: "GB",
    countryName: "United Kingdom",
    currencyCodes: ["GBP"],
    profileIds: ["GB-GBP"],
  },
];

afterEach(cleanup);

describe("CountrySelect", () => {
  it("shows the selected country flag on the trigger", () => {
    render(<CountrySelect value="GB" options={options} onChange={() => {}} />);

    const trigger = screen.getByRole("button", { name: "Country" });
    expect(trigger).toHaveTextContent("United Kingdom");
    expect(trigger.querySelector(".fi.fi-gb")).not.toBeNull();
  });

  it("lists options with flags and reports the selection", () => {
    const onChange = vi.fn();
    render(<CountrySelect value="US" options={options} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Country" }));

    const listbox = screen.getByRole("listbox", { name: "Country" });
    expect(listbox.querySelector(".fi.fi-gb")).not.toBeNull();

    fireEvent.click(
      screen
        .getByRole("option", { name: /United Kingdom/ })
        .querySelector("button")!,
    );
    expect(onChange).toHaveBeenCalledWith("GB");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape without changing the selection", () => {
    const onChange = vi.fn();
    render(<CountrySelect value="US" options={options} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Country" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers an all-markets option that clears the selection", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CountrySelect
        value=""
        options={options}
        allLabel="All markets"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Country" });
    expect(trigger).toHaveTextContent("All markets");
    expect(trigger.querySelector(".fi")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(
      screen
        .getByRole("option", { name: /United States/ })
        .querySelector("button")!,
    );
    expect(onChange).toHaveBeenCalledWith("US");

    onChange.mockClear();
    rerender(
      <CountrySelect
        value="US"
        options={options}
        allLabel="All markets"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Country" }));
    fireEvent.click(
      screen
        .getByRole("option", { name: "All markets" })
        .querySelector("button")!,
    );
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("offers the FX all-markets peer option with the 'all' value and no flag", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CountrySelect
        value="US"
        options={options}
        allMarketsLabel="All markets"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Country" }));
    const option = screen.getByRole("option", { name: /All markets/ });
    // No flag icon for the converted view — there is no country to draw.
    expect(option.querySelector(".fi")).toBeNull();
    fireEvent.click(option.querySelector("button")!);
    expect(onChange).toHaveBeenCalledWith("all");

    rerender(
      <CountrySelect
        value="all"
        options={options}
        allMarketsLabel="All markets"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Country" });
    expect(trigger).toHaveTextContent("All markets");
    expect(trigger.querySelector(".fi")).toBeNull();
  });

  it("disables the all-markets option with an explanation when rates are unavailable", () => {
    const onChange = vi.fn();
    render(
      <CountrySelect
        value="US"
        options={options}
        allMarketsLabel="All markets"
        allMarketsDisabled
        allMarketsDisabledReason="Exchange rates not synced yet"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Country" }));
    const button = screen
      .getByRole("option", { name: /All markets/ })
      .querySelector("button")!;
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Exchange rates not synced yet");

    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
  });
});
