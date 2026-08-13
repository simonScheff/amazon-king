import type { Recommendation } from "@amazon-king/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecommendationDetailPage } from "./recommendation-detail";

const mocks = vi.hoisted(() => ({
  createChangeSet: vi.fn(),
  reject: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
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
  ruleVersion: "cannibalization_conflict@1",
  expiresAt: "2026-08-16T02:01:00.000Z",
  createdAt: "2026-08-13T02:01:00.000Z",
};

vi.mock("../api/endpoints", () => ({
  useRecommendation: () => ({
    isPending: false,
    error: null,
    data: cannibalizationRecommendation,
  }),
  useRejectRecommendation: () => ({
    isPending: false,
    mutate: mocks.reject,
  }),
  useCreateChangeSet: () => ({
    isPending: false,
    mutate: mocks.createChangeSet,
  }),
}));

describe("RecommendationDetailPage", () => {
  beforeEach(() => {
    mocks.createChangeSet.mockReset();
    mocks.reject.mockReset();
    mocks.toast.mockReset();
  });

  it("shows cannibalization as review-only and offers no approval", () => {
    render(<RecommendationDetailPage />);

    expect(
      screen.getByRole("heading", {
        name: "No automatic Amazon Ads action",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No campaign will be created."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No campaign will be selected, paused, or closed."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nothing will be sent to Amazon from this finding."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss finding" }));
    expect(mocks.reject).toHaveBeenCalledOnce();
    expect(mocks.createChangeSet).not.toHaveBeenCalled();
  });
});
