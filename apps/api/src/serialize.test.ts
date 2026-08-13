import { describe, expect, it } from "vitest";
import { isoDate, toContractChangeAction } from "./serialize.js";

describe("isoDate", () => {
  it("normalizes Date objects and timestamp strings to date-only values", () => {
    expect(isoDate(new Date(2026, 7, 13))).toBe("2026-08-13");
    expect(isoDate("2026-08-13T00:00:00.000Z")).toBe("2026-08-13");
    expect(isoDate("2026-08-13")).toBe("2026-08-13");
  });
});

describe("toContractChangeAction", () => {
  it("includes Amazon's validation detail in a failed action", () => {
    const action = toContractChangeAction({
      id: "2",
      changeSetId: "2",
      recommendationId: null,
      actionType: "update_bid",
      campaignId: null,
      adGroupId: null,
      targetId: null,
      searchTerm: null,
      beforeValue: "0.7500",
      afterValue: "0.6500",
      fingerprint: "fingerprint",
      status: "failed",
      amazonRequest: null,
      amazonResponse: {
        message: "Amazon request to /sp/targets failed with status 400",
        details: { Message: "NUMBER_VALUE can not be converted to a String" },
      },
      amazonRequestId: "request-id",
      verifiedAt: null,
      rollbackOfId: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      amazonEntityId: "519095653042278",
      entityName: null,
      beforeState: null,
      afterState: null,
    });

    expect(action.errorMessage).toBe(
      "Amazon request to /sp/targets failed with status 400: NUMBER_VALUE can not be converted to a String",
    );
  });
});
