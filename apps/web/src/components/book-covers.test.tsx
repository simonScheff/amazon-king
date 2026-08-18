import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BookCoverStack, BookCoverThumb } from "./book-covers";

afterEach(() => cleanup());

describe("BookCoverThumb", () => {
  it("renders the cover image with an identifying alt", () => {
    render(
      <BookCoverThumb
        title="Farm Tractors"
        coverImageUrl="https://example.com/cover.jpg"
      />,
    );

    expect(
      screen.getByRole("img", { name: "Farm Tractors cover" }),
    ).toHaveAttribute("src", "https://example.com/cover.jpg");
  });

  it("renders a placeholder when the cover URL is missing", () => {
    const { container } = render(<BookCoverThumb title="Uncovered" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("span[title='Uncovered']")).not.toBeNull();
  });
});

describe("BookCoverStack", () => {
  const books = [
    {
      id: "1",
      title: "First",
      coverImageUrl: "https://example.com/1.jpg",
    },
    {
      id: "2",
      title: "Second",
      coverImageUrl: "https://example.com/2.jpg",
    },
    {
      id: "3",
      title: "Third",
      coverImageUrl: null,
    },
    {
      id: "4",
      title: "Fourth",
      coverImageUrl: "https://example.com/4.jpg",
    },
  ];

  it("renders nothing when no books are linked", () => {
    const { container } = render(<BookCoverStack bookIds={[]} books={books} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders linked covers and caps the stack at three plus a remainder", () => {
    render(<BookCoverStack bookIds={["1", "2", "3", "4"]} books={books} />);

    expect(
      screen.getByRole("img", { name: "First cover" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Second cover" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Fourth cover" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });
});
