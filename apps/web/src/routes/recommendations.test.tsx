import type { Recommendation } from "@amazon-king/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "../lib/format";
import { RecommendationsPage } from "./recommendations";

const createdAt = "2026-08-13T02:01:00.000Z";

const recommendation: Recommendation = {
  id: "rec-1",
  type: "wasteful_search_term",
  state: "pending",
  priority: 2,
  profileId: "profile-us",
  campaignId: "10",
  campaign: {
    campaignId: "camp-1",
    name: "Research Broad",
    state: "enabled",
  },
  adGroupId: null,
  targetId: null,
  searchTerm: "tractor colouring book",
  currentValue: null,
  proposedValue: null,
  rationale: "Clicks and spend with zero orders.",
  confidence: 0.7,
  evidenceWindow: { start: "2026-07-01", end: "2026-07-30" },
  dataFreshness: "2026-08-13T02:01:00.000Z",
  ruleVersion: "wasteful_search_term.v1",
  expiresAt: "2026-08-16T02:01:00.000Z",
  createdAt,
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

vi.mock("../api/endpoints", () => ({
  useRecommendations: () => ({
    isPending: false,
    error: null,
    data: [recommendation],
  }),
  useRejectRecommendation: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

vi.mock("../components/toast", () => ({
  useToast: () => vi.fn(),
}));

describe("RecommendationsPage", () => {
  afterEach(() => cleanup());

  it("shows when each finding was created", () => {
    render(<RecommendationsPage />);

    expect(
      screen.getByRole("columnheader", { name: "Created" }),
    ).toBeInTheDocument();
    expect(screen.getByText(formatDateTime(createdAt))).toBeInTheDocument();
  });
});
