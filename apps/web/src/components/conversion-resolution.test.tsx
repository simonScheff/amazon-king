import type {
  ConversionResolutionContext,
  Recommendation,
} from "@amazon-king/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversionResolution } from "./conversion-resolution";

const mocks = vi.hoisted(() => ({
  createNegatives: vi.fn(),
  reject: vi.fn(),
  updateState: vi.fn(),
  toast: vi.fn(),
  context: null as ConversionResolutionContext | null,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { id?: string };
    search?: Record<string, unknown>;
    [key: string]: unknown;
  }) => {
    const path = params?.id ? to.replace("$id", params.id) : to;
    const query = search
      ? Object.entries(search)
          .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
          .join("&")
      : "";
    return (
      <a href={query ? `${path}?${query}` : path} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("../api/endpoints", () => ({
  useConversionResolutionContext: () => ({
    isPending: false,
    error: null,
    data: mocks.context,
  }),
  useCreateCampaignNegatives: () => ({
    isPending: false,
    mutate: mocks.createNegatives,
  }),
  useRejectRecommendation: () => ({
    isPending: false,
    mutate: mocks.reject,
  }),
  useUpdateCampaignState: () => ({
    isPending: false,
    mutate: mocks.updateState,
  }),
}));

vi.mock("../api/client", () => ({ isReauthError: () => false }));

vi.mock("./campaign-max-cpc", () => ({
  CampaignMaxCpc: ({
    suggestedMaxCpc,
  }: {
    suggestedMaxCpc?: string | null;
  }) => <div data-testid="max-cpc">suggested {suggestedMaxCpc}</div>,
}));

vi.mock("./reauth-dialog", () => ({
  ReauthDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Re-auth</div> : null,
}));

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

vi.mock("./toast", () => ({ useToast: () => mocks.toast }));

const recommendation: Recommendation = {
  id: "rec-1",
  type: "high_ctr_poor_conversion",
  state: "pending",
  priority: 2,
  profileId: "1665213640406890",
  campaignId: "10",
  campaign: {
    campaignId: "camp-1",
    name: "Colouring book – exact",
    state: "enabled",
  },
  adGroupId: null,
  targetId: null,
  searchTerm: null,
  currentValue: null,
  proposedValue: null,
  rationale: "120 clicks and 1 order in the evidence window.",
  confidence: 0.6,
  evidenceWindow: { start: "2026-07-01", end: "2026-07-30" },
  dataFreshness: "2026-08-01T10:00:00.000Z",
  ruleVersion: "high_ctr_poor_conversion.v1",
  expiresAt: "2026-08-08T10:00:00.000Z",
  createdAt: "2026-08-01T10:00:00.000Z",
};

function context(
  overrides: Partial<ConversionResolutionContext> = {},
): ConversionResolutionContext {
  return {
    recommendationId: "rec-1",
    profileId: "1665213640406890",
    countryCode: "GB",
    currency: "GBP",
    confidence: 0.6,
    evidenceWindow: { start: "2026-07-01", end: "2026-07-30" },
    dataFreshness: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-08-08T10:00:00.000Z",
    campaign: {
      campaignId: "camp-1",
      name: "Colouring book – exact",
      state: "enabled",
      targetingType: "manual",
      amazonConsoleUrl:
        "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY123",
      writeEnabled: true,
    },
    metrics: {
      impressions: 4000,
      clicks: 120,
      orders: 1,
      ctr: 0.03,
      cvr: 0.0083,
      spend: "48.0000",
      averageCpc: "0.4000",
      suggestedMaxCpc: "0.2800",
    },
    books: [
      {
        bookId: "7",
        title: "Tractors to Colour",
        asin: "B0TRACTOR1",
        coverImageUrl: null,
      },
    ],
    wastefulTerms: [
      {
        searchTerm: "tractor colouring book",
        impressions: 900,
        clicks: 40,
        orders: 0,
        spend: "18.0000",
      },
    ],
    ...overrides,
  };
}

describe("ConversionResolution", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.createNegatives.mockReset();
    mocks.reject.mockReset();
    mocks.updateState.mockReset();
    mocks.toast.mockReset();
    mocks.context = context();
  });

  it("links the campaign by its Amazon id, the console, and the listing", () => {
    render(<ConversionResolution recommendation={recommendation} />);

    expect(screen.getByText("Colouring book – exact")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open campaign" })).toHaveAttribute(
      "href",
      "/campaigns/camp-1?days=30",
    );
    expect(
      screen.getByRole("link", { name: /Open in Amazon Ads/ }),
    ).toHaveAttribute(
      "href",
      "https://advertising.amazon.com/cm/campaigns?entityId=ENTITY123",
    );
    expect(
      screen.getByRole("link", { name: /View the listing shoppers see/ }),
    ).toHaveAttribute("href", "https://www.amazon.co.uk/dp/B0TRACTOR1");
  });

  it("offers all four responses and reveals only the chosen one", () => {
    render(<ConversionResolution recommendation={recommendation} />);

    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.queryByTestId("max-cpc")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Cap what one click/ }));

    expect(screen.getByTestId("max-cpc")).toHaveTextContent("suggested 0.2800");
    expect(
      screen.queryByRole("button", { name: "Pause this campaign" }),
    ).not.toBeInTheDocument();
  });

  it("drafts negatives only for the terms that were ticked", () => {
    render(<ConversionResolution recommendation={recommendation} />);
    fireEvent.click(screen.getByRole("radio", { name: /Block the shopper/ }));

    const draftButton = screen.getByRole("button", {
      name: "Select the terms to block",
    });
    expect(draftButton).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Block tractor colouring book" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft 1 negative" }));

    expect(mocks.createNegatives).toHaveBeenCalledWith(
      { searchTerms: ["tractor colouring book"] },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("says nothing is worth blocking when every term converts", () => {
    mocks.context = context({ wastefulTerms: [] });
    render(<ConversionResolution recommendation={recommendation} />);
    fireEvent.click(screen.getByRole("radio", { name: /Block the shopper/ }));

    expect(screen.getByText(/nothing safe to block/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("requires a confirmation before pausing the campaign", () => {
    render(<ConversionResolution recommendation={recommendation} />);
    fireEvent.click(screen.getByRole("radio", { name: /Pause the campaign/ }));

    fireEvent.click(
      screen.getByRole("button", { name: "Pause this campaign" }),
    );
    expect(mocks.updateState).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Pause campaign" }));
    expect(mocks.updateState).toHaveBeenCalledWith(
      { state: "paused" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("blocks pausing while the profile is read-only", () => {
    const base = context();
    mocks.context = context({
      campaign: { ...base.campaign, writeEnabled: false },
    });
    render(<ConversionResolution recommendation={recommendation} />);
    fireEvent.click(screen.getByRole("radio", { name: /Pause the campaign/ }));

    expect(
      screen.getByRole("button", { name: "Pause this campaign" }),
    ).toBeDisabled();
    expect(screen.getByText(/profile is read-only/)).toBeInTheDocument();
  });

  it("snoozes the finding for 30 days from the listing checklist", () => {
    render(<ConversionResolution recommendation={recommendation} />);
    fireEvent.click(screen.getByRole("radio", { name: /Fix the listing/ }));

    fireEvent.click(
      screen.getByRole("button", {
        name: "I am fixing the listing — remind me in 30 days",
      }),
    );

    expect(mocks.reject).toHaveBeenCalledWith(
      { snoozeDays: 30 },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
