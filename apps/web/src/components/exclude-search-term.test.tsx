import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExcludeSearchTerm } from "./exclude-search-term";

const mocks = vi.hoisted(() => ({
  createNegatives: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("../api/endpoints", () => ({
  useCreateCampaignNegatives: () => ({
    isPending: false,
    mutate: mocks.createNegatives,
  }),
}));

vi.mock("./toast", () => ({ useToast: () => mocks.toast }));

// jsdom lacks HTMLDialogElement.showModal/close; render a minimal stand-in.
vi.mock("./ui/dialog", () => ({
  Dialog: (props: {
    open: boolean;
    title: string;
    children: ReactNode;
    confirmLabel?: string;
    onConfirm?: () => void;
    onClose: () => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        {props.children}
        {props.onConfirm && (
          <button onClick={props.onConfirm}>
            {props.confirmLabel ?? "Confirm"}
          </button>
        )}
        <button onClick={props.onClose}>Cancel</button>
      </div>
    ) : null,
}));

describe("ExcludeSearchTerm", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.createNegatives.mockReset();
    mocks.toast.mockReset();
  });

  it("asks for confirmation and drafts a negative for the term", () => {
    render(<ExcludeSearchTerm campaignId="c1" term="tractor gifts" />);

    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    const dialog = screen.getByRole("dialog", {
      name: "Exclude this search term?",
    });
    expect(dialog).toHaveTextContent("tractor gifts");
    expect(dialog).toHaveTextContent("negative exact keyword");

    fireEvent.click(screen.getByRole("button", { name: "Draft negative" }));

    expect(mocks.createNegatives).toHaveBeenCalledWith(
      { searchTerms: ["tractor gifts"] },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("describes an ASIN term as a negative product target", () => {
    render(<ExcludeSearchTerm campaignId="c1" term="B0CRHVCT1T" />);

    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));

    expect(
      screen.getByRole("dialog", { name: "Exclude this search term?" }),
    ).toHaveTextContent("negative ASIN product target");
  });

  it("shows the term as already excluded without offering the action", () => {
    render(
      <ExcludeSearchTerm campaignId="c1" term="free books" alreadyExcluded />,
    );

    expect(screen.getByText("Excluded")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Exclude" }),
    ).not.toBeInTheDocument();
  });

  it("links to Change center once the draft is created", () => {
    mocks.createNegatives.mockImplementation(
      (
        _body: unknown,
        options: { onSuccess: (changeSet: { id: string }) => void },
      ) => options.onSuccess({ id: "42" }),
    );
    render(<ExcludeSearchTerm campaignId="c1" term="tractor gifts" />);

    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft negative" }));

    expect(
      screen.getByRole("link", { name: "Review draft 42 →" }),
    ).toHaveAttribute("href", "/changes");
    expect(mocks.toast).toHaveBeenCalledWith("Draft change set 42 created");
  });
});
