import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SearchTermExclusionResult } from "@amazon-king/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExcludeSearchTermGlobal } from "./exclude-search-term-global";

const mocks = vi.hoisted(() => ({
  createExclusion: vi.fn(),
  removeExclusion: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("../api/endpoints", () => ({
  useCreateSearchTermExclusion: () => ({
    isPending: false,
    mutate: mocks.createExclusion,
  }),
  useDeleteSearchTermExclusion: () => ({
    isPending: false,
    mutate: mocks.removeExclusion,
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

function result(
  overrides: Partial<SearchTermExclusionResult> = {},
): SearchTermExclusionResult {
  return {
    term: "fantasy books",
    created: true,
    changeSets: [
      { changeSetId: "41", profileId: "profile-us", campaignCount: 2 },
      { changeSetId: "42", profileId: "profile-de", campaignCount: 1 },
    ],
    skippedCampaigns: 0,
    ...overrides,
  };
}

describe("ExcludeSearchTermGlobal", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.createExclusion.mockReset();
    mocks.removeExclusion.mockReset();
    mocks.toast.mockReset();
  });

  it("confirms the all-market serving scope, then drafts", () => {
    render(<ExcludeSearchTermGlobal term="fantasy books" excluded={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Exclude everywhere" }));
    const dialog = screen.getByRole("dialog", {
      name: "Exclude this search term everywhere?",
    });
    expect(dialog).toHaveTextContent("fantasy books");
    expect(dialog).toHaveTextContent("negative exact keyword");
    expect(dialog).toHaveTextContent(
      "every campaign that ran this search term",
    );
    expect(dialog).toHaveTextContent("all markets");
    expect(dialog).toHaveTextContent("future campaign starts serving the term");
    expect(dialog).toHaveTextContent("Change center");

    fireEvent.click(screen.getByRole("button", { name: "Draft negatives" }));

    expect(mocks.createExclusion).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("describes ASIN terms as negative product targets", () => {
    render(<ExcludeSearchTermGlobal term="B012345678" excluded={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Exclude everywhere" }));

    expect(
      screen.getByRole("dialog", {
        name: "Exclude this search term everywhere?",
      }),
    ).toHaveTextContent("negative ASIN product target");
  });

  it("links to Change center once the drafts are created", () => {
    mocks.createExclusion.mockImplementation(
      (
        _body: unknown,
        options: { onSuccess: (r: SearchTermExclusionResult) => void },
      ) => options.onSuccess(result()),
    );
    render(<ExcludeSearchTermGlobal term="fantasy books" excluded={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Exclude everywhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft negatives" }));

    expect(
      screen.getByRole("link", { name: "Review drafts →" }),
    ).toHaveAttribute("href", "/changes");
    expect(mocks.toast).toHaveBeenCalledWith("2 draft change sets created");
  });

  it("notes when no campaign served the term yet", () => {
    mocks.createExclusion.mockImplementation(
      (
        _body: unknown,
        options: { onSuccess: (r: SearchTermExclusionResult) => void },
      ) => options.onSuccess(result({ changeSets: [] })),
    );
    render(<ExcludeSearchTermGlobal term="fantasy books" excluded={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Exclude everywhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft negatives" }));

    expect(mocks.toast).toHaveBeenCalledWith(
      "Term excluded — no campaign served it yet, so there is nothing to draft",
    );
  });

  it("renders the excluded badge as a button with no exclude action", () => {
    render(<ExcludeSearchTermGlobal term="fantasy books" excluded />);

    expect(
      screen.getByRole("button", { name: "Excluded everywhere" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Exclude everywhere" }),
    ).not.toBeInTheDocument();
  });

  it("confirms removal from the exclusion list when the badge is clicked", () => {
    render(<ExcludeSearchTermGlobal term="fantasy books" excluded />);

    fireEvent.click(
      screen.getByRole("button", { name: "Excluded everywhere" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Remove “fantasy books” from the exclusion list?",
    });
    expect(dialog).toHaveTextContent(
      "will no longer get an automatic exclusion draft",
    );
    expect(dialog).toHaveTextContent(
      "Negatives already applied on Amazon are not removed",
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));

    expect(mocks.removeExclusion).toHaveBeenCalledWith(
      "fantasy books",
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("toasts when the removal succeeds", () => {
    mocks.removeExclusion.mockImplementation(
      (
        _term: string,
        options: { onSuccess: (r: { removed: boolean }) => void },
      ) => options.onSuccess({ removed: true }),
    );
    render(<ExcludeSearchTermGlobal term="fantasy books" excluded />);

    fireEvent.click(
      screen.getByRole("button", { name: "Excluded everywhere" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));

    expect(mocks.toast).toHaveBeenCalledWith(
      "“fantasy books” removed from the exclusion list",
    );
  });
});
