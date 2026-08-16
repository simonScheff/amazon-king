import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignMaxCpc } from "./campaign-max-cpc";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  refetch: vi.fn(),
  applyReset: vi.fn(),
  status: "not_configured",
}));

vi.mock("../api/endpoints", () => ({
  useCampaignMaxCpc: () => ({
    isPending: false,
    error: null,
    refetch: mocks.refetch,
    data: {
      campaignId: "campaign-1",
      profileId: "profile-us",
      currency: "USD",
      maxCpc: null,
      status: mocks.status,
      strategy: "AUTO_FOR_SALES",
      adjustments: [
        { type: "placement", name: "Top of search", percentage: 50 },
      ],
      activeBidRules: [
        {
          id: "rule-1",
          name: "Weekend boost",
          category: "BID",
          subcategory: "SCHEDULE",
          status: "ENABLED",
        },
      ],
      coverageIssues: ["Dynamic bid increases are not disabled"],
      currentMaxBaseBid: "1.2",
      currentMaxAdjustedBid: null,
      counts: { adGroups: 2, explicitTargetBids: 8, bidsAboveCeiling: 0 },
      writeEnabled: true,
      sourceReadAt: "2026-08-13T08:00:00.000Z",
      enforcedAt: null,
    },
  }),
  useSetCampaignMaxCpc: () => ({
    mutate: mocks.set,
    isPending: false,
    error: null,
  }),
  useChangeSetPreview: () => ({ isPending: false, error: null, data: null }),
  useApplyChangeSet: () => ({
    mutate: vi.fn(),
    reset: mocks.applyReset,
    isPending: false,
    error: null,
  }),
}));

vi.mock("./reauth-dialog", () => ({
  ReauthDialog: () => null,
}));

describe("CampaignMaxCpc", () => {
  afterEach(() => {
    cleanup();
    mocks.set.mockReset();
    mocks.applyReset.mockReset();
    mocks.status = "not_configured";
  });

  it("explains uncovered bid paths and submits one ceiling", () => {
    render(<CampaignMaxCpc campaignId="campaign-1" />);

    expect(screen.getByText("One maximum CPC")).toBeInTheDocument();
    expect(screen.getByText("Not bounded")).toBeInTheDocument();
    expect(screen.getAllByText("1 active")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Maximum price per click"), {
      target: { value: "0.75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review ceiling" }));

    expect(mocks.set).toHaveBeenCalledWith(
      { maxCpc: "0.75" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    const onSuccess = mocks.set.mock.calls[0]?.[1]?.onSuccess as (result: {
      changeSet: { id: string };
    }) => void;
    onSuccess({ changeSet: { id: "failed-set-2" } });
    expect(mocks.applyReset).toHaveBeenCalledOnce();
  });

  it("links a pending policy directly to its approval location", () => {
    mocks.status = "pending";

    render(<CampaignMaxCpc campaignId="campaign-1" />);

    expect(
      screen.getByRole("link", {
        name: "Review pending change in Change center →",
      }),
    ).toHaveAttribute("href", "/changes");
  });
});
