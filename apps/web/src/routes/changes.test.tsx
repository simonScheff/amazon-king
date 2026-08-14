import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet } from "@amazon-king/contracts";
import { ChangesPage } from "./changes";

const mocks = vi.hoisted(() => ({
  changeSets: [] as ChangeSet[],
  toast: vi.fn(),
}));

vi.mock("../api/endpoints", () => ({
  useChangeSets: () => ({
    isPending: false,
    error: null,
    data: mocks.changeSets,
  }),
  useChangeSetPreview: (changeSetId: string) => ({
    isPending: false,
    error: null,
    data: {
      changeSet: mocks.changeSets.find((set) => set.id === changeSetId),
      actions: [],
      guardrails: [],
    },
  }),
  useApplyChangeSet: () => ({ isPending: false, mutate: vi.fn() }),
  useRollbackChangeAction: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../components/toast", () => ({
  useToast: () => mocks.toast,
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
    mocks.toast.mockReset();
  });

  it("locks the negatives apply until the creation set is applied", () => {
    mocks.changeSets = [
      changeSet({ id: "set-create", kind: "campaign_creation" }),
      changeSet({
        id: "set-negatives",
        dependsOnChangeSetId: "set-create",
      }),
    ];
    render(<ChangesPage />);

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

    expect(screen.queryByText(/Locked until change set/)).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Apply to Amazon…" }),
    ).toHaveLength(1);
  });
});
