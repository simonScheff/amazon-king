import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SearchTermCampaignRow } from "@amazon-king/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExcludeSearchTermEverywhere } from "./exclude-search-term-everywhere";

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
  useCreateSearchTermNegatives: () => ({
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

function campaign(
  campaignId: string,
  name: string,
  overrides: Partial<SearchTermCampaignRow> = {},
): SearchTermCampaignRow {
  return {
    profileId: "profile-us",
    campaignId,
    name,
    state: "enabled",
    totals: {
      impressions: 60,
      clicks: 6,
      cost: "5.0000",
      sales: "12.0000",
      orders: 1,
      units: 1,
    },
    estimatedRoyalty: "6.0000",
    estimatedAdProfit: "1.0000",
    economicsMissing: false,
    ...overrides,
  };
}

function renderComponent(
  campaigns: SearchTermCampaignRow[] = [
    // Amazon states arrive uppercase; the enabled filter must normalize case.
    campaign("camp-1", "General", { state: "ENABLED" }),
    campaign("camp-2", "Research"),
    campaign("camp-3", "Paused", { state: "PAUSED" }),
  ],
) {
  return render(
    <ExcludeSearchTermEverywhere
      term="fantasy books"
      campaigns={campaigns}
      currency="USD"
      countryCode="US"
      days={7}
    />,
  );
}

describe("ExcludeSearchTermEverywhere", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.createNegatives.mockReset();
    mocks.toast.mockReset();
  });

  it("lists the enabled campaigns and drafts a negative on each", () => {
    renderComponent();

    fireEvent.click(screen.getByRole("button", { name: "Exclude everywhere" }));
    const dialog = screen.getByRole("dialog", {
      name: "Exclude this search term everywhere?",
    });
    expect(dialog).toHaveTextContent("fantasy books");
    expect(dialog).toHaveTextContent("General");
    expect(dialog).toHaveTextContent("Research");
    // Paused campaigns are not offered; the scope is this market only.
    expect(dialog).not.toHaveTextContent("Paused");
    expect(dialog).toHaveTextContent("United States (US) only");

    fireEvent.click(screen.getByRole("button", { name: "Draft negatives" }));

    expect(mocks.createNegatives).toHaveBeenCalledWith(
      { campaignIds: ["camp-1", "camp-2"] },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("disables the action when no enabled campaign runs the term", () => {
    renderComponent([campaign("camp-3", "Paused", { state: "paused" })]);

    const button = screen.getByRole("button", { name: "Exclude everywhere" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "No enabled campaigns run this term in this market",
    );
  });

  it("links to Change center once the drafts are created", () => {
    mocks.createNegatives.mockImplementation(
      (
        _body: unknown,
        options: {
          onSuccess: (result: {
            changeSetIds: string[];
            skippedCampaignIds: string[];
          }) => void;
        },
      ) =>
        options.onSuccess({
          changeSetIds: ["41", "42"],
          skippedCampaignIds: [],
        }),
    );
    renderComponent();

    fireEvent.click(screen.getByRole("button", { name: "Exclude everywhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft negatives" }));

    expect(
      screen.getByRole("link", { name: "Review drafts →" }),
    ).toHaveAttribute("href", "/changes");
    expect(mocks.toast).toHaveBeenCalledWith("2 draft change sets created");
  });
});
