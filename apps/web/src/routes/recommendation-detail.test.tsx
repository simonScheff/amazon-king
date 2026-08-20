import type { Recommendation } from "@amazon-king/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "../lib/format";
import { RecommendationDetailPage } from "./recommendation-detail";

const mocks = vi.hoisted(() => ({
  createChangeSet: vi.fn(),
  createCannibalizationChangeSet: vi.fn(),
  reject: vi.fn(),
  toast: vi.fn(),
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
    params?: { id?: string; term?: string };
    search?: Record<string, unknown>;
    [key: string]: unknown;
  }) => {
    let path = to;
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          path = path.replace(`$${key}`, encodeURIComponent(value));
        }
      }
    }
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
  useParams: () => ({ id: "rec-1" }),
}));

vi.mock("../components/toast", () => ({
  useToast: () => mocks.toast,
}));

const cannibalizationRecommendation: Recommendation = {
  id: "rec-1",
  type: "cannibalization_conflict",
  state: "pending",
  priority: 1,
  profileId: "1665213640406890",
  campaignId: null,
  campaign: null,
  adGroupId: null,
  targetId: null,
  searchTerm: "tractor colouring book",
  currentValue: null,
  proposedValue: null,
  rationale:
    'Search term "tractor colouring book" is targeted in 2 campaigns (1, 2). Human review required.',
  confidence: 0.5,
  evidenceWindow: { start: "2026-06-14", end: "2026-08-12" },
  dataFreshness: "2026-08-13T02:01:00.000Z",
  ruleVersion: "cannibalization_conflict@2",
  expiresAt: "2026-08-16T02:01:00.000Z",
  createdAt: "2026-08-13T02:01:00.000Z",
};

vi.mock("../api/endpoints", () => ({
  useRecommendation: () => ({
    isPending: false,
    error: null,
    data: cannibalizationRecommendation,
  }),
  useCannibalizationResolutionContext: () => ({
    isPending: false,
    error: null,
    data: {
      recommendationId: "rec-1",
      profileId: "1665213640406890",
      searchTerm: "tractor colouring book",
      currency: "GBP",
      confidence: 0.5,
      evidenceWindow: { start: "2026-06-14", end: "2026-08-12" },
      dataFreshness: "2026-08-13T02:01:00.000Z",
      expiresAt: "2026-08-16T02:01:00.000Z",
      totalSpend: "21.9800",
      campaigns: [
        {
          campaignId: "1",
          name: "Campaign 1",
          state: "enabled",
          targetingType: "manual",
          spend: "13.0000",
          orders: 2,
        },
        {
          campaignId: "2",
          name: "Campaign 2",
          state: "enabled",
          targetingType: "auto",
          spend: "8.9800",
          orders: 1,
        },
      ],
    },
  }),
  useCreateCannibalizationChangeSet: () => ({
    isPending: false,
    mutate: mocks.createCannibalizationChangeSet,
  }),
  useRejectRecommendation: () => ({
    isPending: false,
    mutate: mocks.reject,
  }),
  useCreateChangeSet: () => ({
    isPending: false,
    mutate: mocks.createChangeSet,
  }),
  useProfiles: () => ({
    isPending: false,
    error: null,
    data: [
      {
        profileId: "1665213640406890",
        region: "EU",
        countryCode: "GB",
        currencyCode: "GBP",
        enabled: true,
        writeEnabled: true,
      },
    ],
  }),
}));

describe("RecommendationDetailPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.createChangeSet.mockReset();
    mocks.createCannibalizationChangeSet.mockReset();
    mocks.reject.mockReset();
    mocks.toast.mockReset();
  });

  it("routes a cannibalization term with a destination-specific draft", () => {
    render(<RecommendationDetailPage />);

    expect(
      screen.getByRole("heading", {
        name: "Resolve cannibalization conflict",
      }),
    ).toBeInTheDocument();
    const createButton = screen.getByRole("button", {
      name: "Choose a destination to continue",
    });
    expect(createButton).toBeDisabled();

    const campaignLink = screen.getByRole("link", {
      name: "Open Campaign 1 in a new tab",
    });
    expect(campaignLink).toHaveAttribute("href", "/campaigns/1?days=60");
    expect(campaignLink).toHaveAttribute("target", "_blank");
    expect(campaignLink).toHaveAttribute("rel", "noopener noreferrer");

    const searchTermLink = screen.getByRole("link", {
      name: "Open tractor colouring book in a new tab",
    });
    expect(searchTermLink).toHaveAttribute(
      "href",
      "/search-terms/tractor%20colouring%20book?days=60&country=GB",
    );
    expect(searchTermLink).toHaveAttribute("target", "_blank");
    expect(searchTermLink).toHaveAttribute("rel", "noopener noreferrer");

    const created = screen.getByText("Created");
    expect(created.tagName).toBe("DT");
    expect(created.nextElementSibling).toHaveTextContent(
      formatDateTime(cannibalizationRecommendation.createdAt),
    );

    fireEvent.click(screen.getByRole("radio", { name: /campaign 1/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Create draft change set" }),
    );

    expect(mocks.createCannibalizationChangeSet).toHaveBeenCalledWith(
      { destinationCampaignId: "1" },
      expect.any(Object),
    );
    expect(mocks.createChangeSet).not.toHaveBeenCalled();
  });

  it("offers a new campaign as destination, prefilled with the search term", () => {
    render(<RecommendationDetailPage />);

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Create a new campaign as destination",
      }),
    );

    // The CTA becomes a wizard link carrying the finding, term, and market.
    const wizardLink = screen.getByRole("link", {
      name: "Set up the new campaign",
    });
    expect(wizardLink).toHaveAttribute(
      "href",
      "/campaigns/new?recommendationId=rec-1&searchTerm=tractor%20colouring%20book&country=GB",
    );

    // Every current campaign is listed as a negative-exact target, and the
    // lock note explains the ordering guarantee.
    expect(
      screen.getByText("Campaign 1 · add campaign-level negative exact"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Campaign 2 · add campaign-level negative exact"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never unavailable everywhere/),
    ).toBeInTheDocument();

    // The classic draft path is not used for this destination.
    expect(
      screen.queryByRole("button", { name: "Create draft change set" }),
    ).not.toBeInTheDocument();
  });
});
