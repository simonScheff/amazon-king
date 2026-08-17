import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductFilter } from "./product-filter";

const mocks = vi.hoisted(() => ({
  useBooks: vi.fn(),
  useSearch: vi.fn((): { books?: string[] } => ({})),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: mocks.useSearch,
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/endpoints", () => ({
  useBooks: mocks.useBooks,
}));

const BOOKS = [
  { id: "1", asin: "B001", title: "First title", format: "ebook" },
  { id: "3", asin: "B002", title: "Second title", format: "paperback" },
  { id: "7", asin: "B003", title: "Third title", format: "ebook" },
];

/**
 * Runs the functional search updater the component passed to navigate against
 * a previous search value, mirroring what the router would do.
 */
function resultingSearch(prev: Record<string, unknown>) {
  const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
    replace: boolean;
  };
  expect(call.replace).toBe(true);
  return call.search(prev);
}

describe("ProductFilter", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSearch.mockReturnValue({});
    mocks.useBooks.mockReturnValue({ data: BOOKS, isPending: false });
  });

  it("defaults to all products and lists every book as a checkbox", () => {
    render(<ProductFilter />);

    const trigger = screen.getByRole("button", { name: /^Filter by product/ });
    expect(trigger).toHaveTextContent("All products");

    fireEvent.click(trigger);
    const group = screen.getByRole("group", { name: "Products" });
    const boxes = Array.from(group.querySelectorAll("input"));
    expect(boxes).toHaveLength(4);
    expect(
      screen.getByRole("checkbox", { name: "All products" }),
    ).toBeChecked();
    expect(screen.getByText("First title")).toBeInTheDocument();
    expect(screen.getByText("(paperback)")).toBeInTheDocument();
  });

  it("checking a book adds it to the books search param", () => {
    render(<ProductFilter />);

    fireEvent.click(screen.getByRole("button", { name: /^Filter by product/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Second title/ }));

    expect(resultingSearch({})).toEqual({ books: ["3"] });
  });

  it("checking a second book keeps the first and shows the count", () => {
    mocks.useSearch.mockReturnValue({ books: ["1"] });
    render(<ProductFilter />);

    const trigger = screen.getByRole("button", { name: /^Filter by product/ });
    expect(trigger).toHaveTextContent("First title");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("checkbox", { name: /Second title/ }));

    expect(resultingSearch({ books: ["1"] })).toEqual({ books: ["1", "3"] });

    mocks.useSearch.mockReturnValue({ books: ["1", "3"] });
    cleanup();
    render(<ProductFilter />);
    expect(
      screen.getByRole("button", { name: /^Filter by product/ }),
    ).toHaveTextContent("2 products");
  });

  it("unchecking a book removes it, and All products clears the selection", () => {
    mocks.useSearch.mockReturnValue({ books: ["1", "3"] });
    render(<ProductFilter />);

    fireEvent.click(screen.getByRole("button", { name: /^Filter by product/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First title/ }));
    expect(resultingSearch({ books: ["1", "3"] })).toEqual({ books: ["3"] });

    fireEvent.click(screen.getByRole("checkbox", { name: "All products" }));
    expect(resultingSearch({ books: ["3"] })).toEqual({ books: undefined });
  });

  it("preserves unrelated search params when changing the selection", () => {
    render(<ProductFilter />);

    fireEvent.click(screen.getByRole("button", { name: /^Filter by product/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First title/ }));

    expect(resultingSearch({ days: 30, country: "DE" })).toEqual({
      days: 30,
      country: "DE",
      books: ["1"],
    });
  });

  it("closes on Escape and on outside pointer down", () => {
    render(<ProductFilter />);

    fireEvent.click(screen.getByRole("button", { name: /^Filter by product/ }));
    expect(screen.getByRole("group", { name: "Products" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Filter by product/ }));
    expect(screen.getByRole("group", { name: "Products" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("collapsed mode keeps the selection in the accessible name and tooltip", () => {
    mocks.useSearch.mockReturnValue({ books: ["1", "3"] });
    render(<ProductFilter collapsed />);

    const trigger = screen.getByRole("button", {
      name: "Filter by product: 2 products",
    });
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "Products" })).toBeInTheDocument();
  });
});
