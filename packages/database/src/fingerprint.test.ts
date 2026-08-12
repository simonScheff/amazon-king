import { describe, expect, it } from "vitest";
import { computeBackoffMs, computeBackoffMsWithJitter } from "./backoff.js";
import {
  buildChangeActionFingerprint,
  buildChangeSetFingerprint,
  buildFingerprint,
  buildReportSpecFingerprint,
  stableStringify,
} from "./fingerprint.js";

describe("backoff", () => {
  it("doubles the delay per attempt", () => {
    expect(computeBackoffMs(0)).toBe(1000);
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(3)).toBe(8000);
  });

  it("clamps to maxMs", () => {
    expect(computeBackoffMs(30)).toBe(300_000);
    expect(computeBackoffMs(10, { baseMs: 100, maxMs: 1000 })).toBe(1000);
  });

  it("rejects negative attempts", () => {
    expect(() => computeBackoffMs(-1)).toThrow(RangeError);
  });

  it("applies full jitter within [0, backoff]", () => {
    expect(computeBackoffMsWithJitter(3, {}, () => 0)).toBe(0);
    expect(computeBackoffMsWithJitter(3, {}, () => 0.9999)).toBeLessThanOrEqual(
      8000,
    );
    const mid = computeBackoffMsWithJitter(3, {}, () => 0.5);
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(8000);
  });
});

describe("fingerprints", () => {
  it("stableStringify ignores object key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("stableStringify preserves array order and drops undefined", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ a: 1, b: undefined })).toBe(
      stableStringify({ a: 1 }),
    );
  });

  it("buildFingerprint is deterministic and change-sensitive", () => {
    const a = buildFingerprint({ x: "1", y: 2 });
    expect(a).toBe(buildFingerprint({ y: 2, x: "1" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(buildFingerprint({ x: "1", y: 3 }));
  });

  it("report spec fingerprint ignores column ordering", () => {
    const base = {
      profileId: "1",
      reportType: "spCampaigns",
      dateStart: "2026-07-01",
      dateEnd: "2026-07-31",
    };
    const a = buildReportSpecFingerprint({
      ...base,
      columns: ["clicks", "cost"],
    });
    const b = buildReportSpecFingerprint({
      ...base,
      columns: ["cost", "clicks"],
    });
    expect(a).toBe(b);
    expect(a).not.toBe(
      buildReportSpecFingerprint({
        ...base,
        columns: ["clicks", "cost", "sales"],
      }),
    );
  });

  it("change set/action fingerprints are distinct kinds", () => {
    const spec = {
      profileId: "1",
      creatorUserId: "7",
      actions: [
        { actionType: "update_bid", targetId: "42", afterValue: "0.55" },
      ],
    };
    const setFp = buildChangeSetFingerprint(spec);
    expect(setFp).toBe(buildChangeSetFingerprint(spec));
    const actionFp = buildChangeActionFingerprint({
      changeSetId: "1",
      actionType: "update_bid",
      targetId: "42",
      beforeValue: "0.50",
      afterValue: "0.55",
    });
    expect(actionFp).toMatch(/^[0-9a-f]{64}$/);
    expect(actionFp).not.toBe(setFp);
  });
});
