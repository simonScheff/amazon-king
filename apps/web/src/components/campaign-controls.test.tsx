import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignControls } from "./campaign-controls";

const mocks = vi.hoisted(() => ({
  updateState: vi.fn(),
  rename: vi.fn(),
  toast: vi.fn(),
  reauthError: false,
}));

vi.mock("../api/endpoints", () => ({
  useUpdateCampaignState: () => ({
    mutate: mocks.updateState,
    isPending: false,
    error: null,
  }),
  useRenameCampaign: () => ({
    mutate: mocks.rename,
    isPending: false,
    error: null,
  }),
}));

vi.mock("../api/client", () => ({
  isReauthError: () => mocks.reauthError,
}));

vi.mock("./reauth-dialog", () => ({
  ReauthDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Re-auth</div> : null,
}));

vi.mock("./toast", () => ({
  useToast: () => mocks.toast,
}));

describe("CampaignControls", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.updateState.mockReset();
    mocks.rename.mockReset();
    mocks.toast.mockReset();
    mocks.reauthError = false;
  });

  it("offers Pause on an enabled campaign and Enable on a paused one", () => {
    const { unmount } = render(
      <CampaignControls campaignId="camp-1" name="Campaign" state="enabled" />,
    );
    expect(
      screen.getByRole("button", { name: "Pause campaign" }),
    ).toBeInTheDocument();
    unmount();

    render(
      <CampaignControls campaignId="camp-1" name="Campaign" state="paused" />,
    );
    expect(
      screen.getByRole("button", { name: "Enable campaign" }),
    ).toBeInTheDocument();
  });

  it("pauses via the guarded mutation and toasts on success", () => {
    render(
      <CampaignControls campaignId="camp-1" name="Campaign" state="enabled" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause campaign" }));

    expect(mocks.updateState).toHaveBeenCalledWith(
      { state: "paused" },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    const [, callbacks] = mocks.updateState.mock.calls[0]!;
    callbacks.onSuccess();
    expect(mocks.toast).toHaveBeenCalledWith("Campaign paused");
  });

  it("renames inline: save sends the trimmed name, cancel restores", () => {
    render(
      <CampaignControls campaignId="camp-1" name="Old name" state="enabled" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename campaign" }));

    const input = screen.getByLabelText("Campaign name");
    expect(input).toHaveValue("Old name");
    fireEvent.change(input, { target: { value: "  New name  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.rename).toHaveBeenCalledWith(
      { name: "New name" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("does not call the mutation when the name is unchanged or blank", () => {
    render(
      <CampaignControls campaignId="camp-1" name="Old name" state="enabled" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename campaign" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.rename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rename campaign" }));
    fireEvent.change(screen.getByLabelText("Campaign name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it("opens the re-auth dialog when the mutation fails with REAUTH_REQUIRED", () => {
    mocks.reauthError = true;
    render(
      <CampaignControls campaignId="camp-1" name="Campaign" state="enabled" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause campaign" }));
    const [, callbacks] = mocks.updateState.mock.calls[0]!;
    act(() => callbacks.onError(new Error("reauth")));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
