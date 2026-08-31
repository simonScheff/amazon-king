import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { CampaignMaxCpc } from "./campaign-max-cpc";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  refetch: vi.fn(),
  applyReset: vi.fn(),
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  reauthProps: null as Record<string, unknown> | null,
  status: "not_configured",
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

vi.mock("../api/endpoints", () => ({
  useSession: () => ({ data: { email: "owner@example.com" } }),
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
  ReauthDialog: (props: Record<string, unknown>) => {
    mocks.reauthProps = props;
    return null;
  },
}));

// jsdom lacks HTMLDialogElement.showModal/close; render a minimal stand-in.
vi.mock("./ui/dialog", () => ({
  Dialog: (props: { open: boolean; children?: ReactNode }) =>
    props.open ? <div role="dialog">{props.children}</div> : null,
}));

describe("CampaignMaxCpc", () => {
  afterEach(() => {
    cleanup();
    mocks.set.mockReset();
    mocks.applyReset.mockReset();
    mocks.navigate.mockReset();
    mocks.search = {};
    mocks.reauthProps = null;
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

  it("restores the typed ceiling from the re-auth return URL and resubmits it", () => {
    mocks.search = { tab: "maxCpc", maxCpc: "2.00" };

    render(<CampaignMaxCpc campaignId="campaign-1" />);

    expect(screen.getByLabelText("Maximum price per click")).toHaveValue(
      "2.00",
    );
    // The interrupted "Review ceiling" click is redone automatically.
    expect(mocks.set).toHaveBeenCalledWith(
      { maxCpc: "2.00" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    // The resume params are stripped so a later reload does not resubmit.
    const strip = mocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
      replace: boolean;
    };
    expect(strip.replace).toBe(true);
    expect(strip.search({ tab: "maxCpc", maxCpc: "2.00" })).toEqual({
      tab: "maxCpc",
      maxCpc: undefined,
      draft: undefined,
    });
  });

  it("reopens the pending review from the return URL without drafting again", () => {
    mocks.search = { tab: "maxCpc", maxCpc: "2.00", draft: "42" };

    render(<CampaignMaxCpc campaignId="campaign-1" />);

    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("carries the typed ceiling in the re-auth return path and resumes in place", () => {
    render(<CampaignMaxCpc campaignId="campaign-1" />);

    fireEvent.change(screen.getByLabelText("Maximum price per click"), {
      target: { value: "0.75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review ceiling" }));

    const onError = mocks.set.mock.calls[0]?.[1]?.onError as (
      err: unknown,
    ) => void;
    act(() => onError(new ApiError(401, "reauth", "REAUTH_REQUIRED")));

    const props = mocks.reauthProps as unknown as {
      open: boolean;
      next: string;
      onReauthenticated: () => void;
    };
    expect(props.open).toBe(true);
    expect(props.next).toContain("maxCpc=0.75");

    // The installed-app paste flow never navigates: the blocked submit is
    // re-run directly with the value still in state.
    act(() => props.onReauthenticated());
    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenLastCalledWith(
      { maxCpc: "0.75" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
