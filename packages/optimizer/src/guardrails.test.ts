import { describe, expect, it } from "vitest";
import {
  checkGuardrails,
  type GuardrailAction,
  type GuardrailInput,
} from "./guardrails.js";
import { TEST_NOW } from "./testUtils.js";

const freshEvidenceEnd = "2026-02-14"; // 1 day before TEST_NOW's date

function bidAction(overrides: Partial<GuardrailAction> = {}): GuardrailAction {
  return {
    actionType: "update_bid",
    targetId: "t-1",
    campaignId: "camp-1",
    beforeMicros: 1_000_000,
    afterMicros: 1_100_000, // +10%
    evidenceEnd: freshEvidenceEnd,
    ...overrides,
  };
}

function baseInput(overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    killSwitch: false,
    writeEnabled: true,
    now: TEST_NOW,
    actions: [bidAction()],
    ...overrides,
  };
}

describe("checkGuardrails", () => {
  it("allows a well-formed change set", () => {
    const result = checkGuardrails(baseInput());
    expect(result).toEqual({ allowed: true, violations: [] });
  });

  it("blocks everything when the kill switch is on", () => {
    const result = checkGuardrails(baseInput({ killSwitch: true }));
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain(
      "KILL_SWITCH_ENABLED",
    );
  });

  it("blocks when the profile is read-only (the default)", () => {
    const result = checkGuardrails(baseInput({ writeEnabled: false }));
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("PROFILE_READ_ONLY");
  });

  it("rejects a bid change above 15%", () => {
    const result = checkGuardrails(
      baseInput({ actions: [bidAction({ afterMicros: 1_150_001 })] }),
    );
    expect(result.violations.map((v) => v.code)).toContain(
      "BID_CHANGE_TOO_LARGE",
    );
  });

  it("allows a bid change at exactly 15%", () => {
    const result = checkGuardrails(
      baseInput({ actions: [bidAction({ afterMicros: 1_150_000 })] }),
    );
    expect(result.allowed).toBe(true);
  });

  it("measures downward changes the same way", () => {
    const ok = checkGuardrails(
      baseInput({ actions: [bidAction({ afterMicros: 850_000 })] }),
    );
    expect(ok.allowed).toBe(true);
    const tooFar = checkGuardrails(
      baseInput({ actions: [bidAction({ afterMicros: 849_999 })] }),
    );
    expect(tooFar.violations.map((v) => v.code)).toContain(
      "BID_CHANGE_TOO_LARGE",
    );
  });

  it("blocks a second bid change inside the cooldown period", () => {
    const result = checkGuardrails(
      baseInput({
        recentChanges: [
          {
            actionType: "update_bid",
            targetId: "t-1",
            campaignId: null,
            searchTerm: null,
            changedAt: "2026-02-14T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain(
      "BID_COOLDOWN_ACTIVE",
    );
  });

  it("allows the change once the cooldown has passed", () => {
    const result = checkGuardrails(
      baseInput({
        recentChanges: [
          {
            actionType: "update_bid",
            targetId: "t-1",
            campaignId: null,
            searchTerm: null,
            changedAt: "2026-02-01T00:00:00.000Z", // 14 days earlier
          },
        ],
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("refuses a negative on a protected term", () => {
    const result = checkGuardrails(
      baseInput({
        actions: [
          {
            actionType: "add_negative_exact",
            searchTerm: "My Book Title",
            evidenceEnd: freshEvidenceEnd,
          },
        ],
        config: { protectedSearchTerms: ["my book title"] },
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain("PROTECTED_ENTITY");
  });

  it("refuses any change on a protected campaign", () => {
    const result = checkGuardrails(
      baseInput({ config: { protectedCampaignIds: ["camp-1"] } }),
    );
    expect(result.violations.map((v) => v.code)).toContain("PROTECTED_ENTITY");
  });

  it("enforces the max daily budget", () => {
    const result = checkGuardrails(
      baseInput({
        actions: [
          {
            actionType: "update_budget",
            campaignId: "camp-1",
            beforeMicros: 10_000_000,
            afterMicros: 12_000_000,
            evidenceEnd: freshEvidenceEnd,
          },
        ],
        config: { maxDailyBudgetMicros: 11_000_000 },
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain(
      "BUDGET_EXCEEDS_MAX",
    );
  });

  it("enforces the max single budget increase", () => {
    const result = checkGuardrails(
      baseInput({
        actions: [
          {
            actionType: "update_budget",
            campaignId: "camp-1",
            beforeMicros: 10_000_000,
            afterMicros: 13_000_000, // +30% > 25% max
            evidenceEnd: freshEvidenceEnd,
          },
        ],
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain(
      "BUDGET_INCREASE_TOO_LARGE",
    );
  });

  it("enforces the action-count limit per change set", () => {
    const actions = Array.from({ length: 21 }, (_, i) =>
      bidAction({ targetId: `t-${i}` }),
    );
    const result = checkGuardrails(baseInput({ actions }));
    expect(result.violations.map((v) => v.code)).toContain("TOO_MANY_ACTIONS");
  });

  it("enforces the monetary exposure limit across the whole set", () => {
    const result = checkGuardrails(
      baseInput({
        actions: [
          bidAction({
            targetId: "t-1",
            beforeMicros: 10_000_000,
            afterMicros: 11_500_000,
          }),
          bidAction({
            targetId: "t-2",
            beforeMicros: 10_000_000,
            afterMicros: 11_500_000,
          }),
        ],
        config: { maxExposureMicros: 2_000_000 },
      }),
    );
    expect(result.violations.map((v) => v.code)).toContain(
      "EXPOSURE_TOO_LARGE",
    );
  });

  it("refuses writes based on stale evidence", () => {
    const result = checkGuardrails(
      baseInput({ actions: [bidAction({ evidenceEnd: "2026-02-10" })] }),
    );
    expect(result.violations.map((v) => v.code)).toContain("STALE_EVIDENCE");
  });

  it("accepts evidence at exactly the staleness boundary", () => {
    const result = checkGuardrails(
      baseInput({ actions: [bidAction({ evidenceEnd: "2026-02-12" })] }),
    );
    expect(result.allowed).toBe(true); // exactly 3 days old
  });

  it("collects multiple violations at once", () => {
    const result = checkGuardrails(
      baseInput({
        killSwitch: true,
        writeEnabled: false,
        actions: [
          bidAction({ afterMicros: 2_000_000, evidenceEnd: "2026-01-01" }),
        ],
      }),
    );
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("KILL_SWITCH_ENABLED");
    expect(codes).toContain("PROFILE_READ_ONLY");
    expect(codes).toContain("BID_CHANGE_TOO_LARGE");
    expect(codes).toContain("STALE_EVIDENCE");
    expect(result.allowed).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const input = baseInput({ killSwitch: true });
    expect(checkGuardrails(input)).toEqual(checkGuardrails(input));
  });
});
