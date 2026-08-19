import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ChangeSet } from "@amazon-king/contracts";
import { ApiError } from "../api/client";
import { ChangesPage } from "./changes";

const mocks = vi.hoisted(() => ({
  changeSets: [] as ChangeSet[],
  actions: [] as Record<string, unknown>[],
  toast: vi.fn(),
  applyMutate: vi.fn(),
  search: {} as { apply?: string },
  navigate: vi.fn(),
}));

vi.mock("../api/endpoints", () => ({
  useChangeSets: () => ({
    isPending: false,
    error: null,
    data: mocks.changeSets,
  }),
  useChangeSetPreview: (changeSetId: string | null) => ({
    isPending: false,
    error: null,
    data: {
      changeSet: mocks.changeSets.find((set) => set.id === changeSetId),
      actions: mocks.actions,
      guardrails: [],
    },
  }),
  useApplyChangeSet: () => ({ isPending: false, mutate: mocks.applyMutate }),
  useRollbackChangeAction: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../components/toast", () => ({
  useToast: () => mocks.toast,
}));

// No router context in these tests; render links as plain anchors.
vi.mock("@tanstack/react-router", () => ({
  Link: (props: {
    to: string;
    params?: { id?: string };
    className?: string;
    children: ReactNode;
  }) => (
    <a
      href={props.to.replace("$id", props.params?.id ?? "")}
      className={props.className}
    >
      {props.children}
    </a>
  ),
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

// jsdom lacks HTMLDialogElement.showModal/close; render minimal stand-ins.
vi.mock("../components/ui/dialog", () => ({
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

vi.mock("../components/reauth-dialog", () => ({
  ReauthDialog: (props: {
    open: boolean;
    next?: string;
    onReauthenticated?: () => void;
  }) =>
    props.open ? (
      <div>
        REAUTH_DIALOG_OPEN
        <span>next: {props.next}</span>
        <button onClick={props.onReauthenticated}>Signed in in place</button>
      </div>
    ) : null,
}));

function changeSet(overrides: Partial<ChangeSet>): ChangeSet {
  return {
    id: "set-1",
    profileId: "amz-profile-1",
    status: "draft",
    createdAt: "2026-08-14T10:00:00.000Z",
    kind: "recommendation",
    ...overrides,
  };
}

describe("ChangesPage dependency gate", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    mocks.changeSets = [];
    mocks.actions = [];
    mocks.search = {};
    mocks.toast.mockReset();
    mocks.applyMutate.mockReset();
    mocks.navigate.mockReset();
  });

  function expand(changeSetId: string) {
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`Change set ${changeSetId}`),
      }),
    );
  }

  it("locks the negatives apply until the creation set is applied", () => {
    mocks.changeSets = [
      changeSet({ id: "set-create", kind: "campaign_creation" }),
      changeSet({
        id: "set-negatives",
        dependsOnChangeSetId: "set-create",
      }),
    ];
    render(<ChangesPage />);
    expand("set-create");
    expand("set-negatives");

    expect(screen.getByText(/Locked until change set/)).toHaveTextContent(
      /set-create/,
    );
    // Only the creation set offers Apply.
    expect(
      screen.getAllByRole("button", { name: "Apply to Amazon…" }),
    ).toHaveLength(1);
  });

  it("unlocks the negatives apply once the creation set is applied", () => {
    mocks.changeSets = [
      changeSet({
        id: "set-create",
        kind: "campaign_creation",
        status: "applied",
      }),
      changeSet({
        id: "set-negatives",
        dependsOnChangeSetId: "set-create",
      }),
    ];
    render(<ChangesPage />);
    expand("set-create");
    expand("set-negatives");

    expect(screen.queryByText(/Locked until change set/)).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Apply to Amazon…" }),
    ).toHaveLength(1);
  });

  it("opens the re-auth dialog instead of an error toast on REAUTH_REQUIRED", () => {
    mocks.changeSets = [changeSet({ id: "set-1", status: "previewed" })];
    mocks.applyMutate.mockImplementation(
      (_arg: unknown, opts: { onError: (err: unknown) => void }) =>
        opts.onError(
          new ApiError(401, "recent sign-in required", "REAUTH_REQUIRED"),
        ),
    );
    render(<ChangesPage />);
    expand("set-1");

    fireEvent.click(screen.getByRole("button", { name: "Apply to Amazon…" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, write to Amazon" }),
    );

    expect(screen.getByText("REAUTH_DIALOG_OPEN")).toBeInTheDocument();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("carries the pending apply back in the re-auth link", () => {
    mocks.changeSets = [changeSet({ id: "set-1", status: "previewed" })];
    mocks.applyMutate.mockImplementation(
      (_arg: unknown, opts: { onError: (err: unknown) => void }) =>
        opts.onError(
          new ApiError(401, "recent sign-in required", "REAUTH_REQUIRED"),
        ),
    );
    render(<ChangesPage />);
    expand("set-1");

    fireEvent.click(screen.getByRole("button", { name: "Apply to Amazon…" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, write to Amazon" }),
    );

    expect(screen.getByText(/next:/)).toHaveTextContent(
      "next: /changes?apply=set-1",
    );
  });

  it("reopens the confirmation for the set the re-auth link returned to", () => {
    mocks.search = { apply: "set-2" };
    mocks.changeSets = [
      changeSet({ id: "set-1", status: "previewed" }),
      changeSet({ id: "set-2", status: "previewed" }),
    ];
    render(<ChangesPage />);

    // Expanded and confirming without a click, and only for that set.
    expect(
      screen.getByRole("dialog", {
        name: "Apply this change set to Amazon?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Yes, write to Amazon" }),
    ).toHaveLength(1);
    // Nothing is written until the user confirms.
    expect(mocks.applyMutate).not.toHaveBeenCalled();
    // The intent is stripped from the URL so a reload does not ask again.
    expect(mocks.navigate).toHaveBeenCalled();
  });

  it("ignores a returned apply intent for a set that is already applied", () => {
    mocks.search = { apply: "set-1" };
    mocks.changeSets = [changeSet({ id: "set-1", status: "applied" })];
    render(<ChangesPage />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finishes the apply when the installed app signs in without navigating", () => {
    mocks.changeSets = [changeSet({ id: "set-1", status: "previewed" })];
    mocks.applyMutate.mockImplementation(
      (_arg: unknown, opts: { onError: (err: unknown) => void }) =>
        opts.onError(
          new ApiError(401, "recent sign-in required", "REAUTH_REQUIRED"),
        ),
    );
    render(<ChangesPage />);
    expand("set-1");

    fireEvent.click(screen.getByRole("button", { name: "Apply to Amazon…" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, write to Amazon" }),
    );
    expect(mocks.applyMutate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Signed in in place" }));

    expect(mocks.applyMutate).toHaveBeenCalledTimes(2);
  });

  it("toasts other apply errors without opening the re-auth dialog", () => {
    mocks.changeSets = [changeSet({ id: "set-1", status: "previewed" })];
    mocks.applyMutate.mockImplementation(
      (_arg: unknown, opts: { onError: (err: unknown) => void }) =>
        opts.onError(new ApiError(409, "stale state", "BEFORE_MISMATCH")),
    );
    render(<ChangesPage />);
    expand("set-1");

    fireEvent.click(screen.getByRole("button", { name: "Apply to Amazon…" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, write to Amazon" }),
    );

    expect(screen.queryByText("REAUTH_DIALOG_OPEN")).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith(
      "Apply failed: stale state",
      "error",
    );
  });

  it("shows the affected campaign and search term per action", () => {
    mocks.changeSets = [changeSet({ id: "set-1", status: "applied" })];
    mocks.actions = [
      {
        id: "action-1",
        changeSetId: "set-1",
        actionType: "add_negative_exact",
        campaignName: "Tractor Launch",
        amazonCampaignId: "amz-camp-1",
        searchTerm: "free tractor books",
        entityName: null,
        beforeValue: null,
        afterValue: null,
        status: "applied",
        amazonRequestId: null,
      },
    ];
    render(<ChangesPage />);

    // Collapsed by default: no action detail leaks before expanding.
    expect(screen.queryByText("Tractor Launch")).toBeNull();

    expand("set-1");

    // The campaign name links through to that campaign's page.
    expect(
      screen.getByRole("link", { name: "Tractor Launch" }),
    ).toHaveAttribute("href", "/campaigns/amz-camp-1");
    expect(screen.getByText("free tractor books")).toBeInTheDocument();
    expect(screen.getByText("Add Negative Exact")).toBeInTheDocument();
  });
});
