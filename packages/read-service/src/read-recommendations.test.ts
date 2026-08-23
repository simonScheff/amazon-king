import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@amazon-king/database", () => ({
  audit: {},
  books: {
    getBook: vi.fn(),
  },
  changes: {},
  connections: {},
  enqueue: {},
  metrics: {
    MixedCurrencyError: class MixedCurrencyError extends Error {},
  },
  profiles: {},
  structure: {},
  reports: {},
  recommendations: {
    listRecommendationsByWorkspace: vi.fn(),
  },
  dashboard: {},
}));

import { books, recommendations } from "@amazon-king/database";
import type { ApiConfig } from "../config.js";
import { createReadService } from "./read.js";

const RECOMMENDATION_ROW = {
  id: "rec-1",
  type: "expensive_target",
  state: "pending",
  priority: 2,
  amazonProfileId: "amazon-profile",
  campaignId: "amazon-campaign",
  adGroupId: null,
  targetId: "amazon-target",
  searchTerm: null,
  currentValue: "0.5000",
  proposedValue: "0.5500",
  rationale: "test",
  confidence: "0.800",
  evidenceWindowStart: "2026-07-01",
  evidenceWindowEnd: "2026-07-31",
  dataFreshnessAt: new Date("2026-08-13T02:01:00.000Z"),
  ruleVersion: "v1",
  expiresAt: new Date("2026-09-13T00:00:00.000Z"),
  createdAt: new Date("2026-08-12T10:00:00.000Z"),
};

describe("recommendations product filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recommendations.listRecommendationsByWorkspace).mockResolvedValue(
      [RECOMMENDATION_ROW as never],
    );
  });

  function service() {
    return createReadService({
      db: {} as never,
      config: { killSwitch: false } as ApiConfig,
      logger: {} as never,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
  }

  it("passes type/state filters through without a product filter", async () => {
    const result = await service().listRecommendations("workspace-pk", {
      state: "pending",
    });

    expect(recommendations.listRecommendationsByWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      {
        type: undefined,
        state: "pending",
        bookIds: null,
      },
    );
    expect(books.getBook).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "rec-1", state: "pending" });
  });

  it("resolves the selected books and forwards their PKs", async () => {
    vi.mocked(books.getBook).mockImplementation(async (_db, id) => {
      if (id === "7" || id === "9") {
        return { id, workspaceId: "workspace-pk" } as never;
      }
      return null;
    });

    await service().listRecommendations("workspace-pk", {
      bookIds: ["7", "9"],
    });

    expect(books.getBook).toHaveBeenCalledTimes(2);
    expect(recommendations.listRecommendationsByWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-pk",
      {
        type: undefined,
        state: undefined,
        bookIds: [7n, 9n],
      },
    );
  });

  it("rejects an unknown book id with 404 before listing", async () => {
    vi.mocked(books.getBook).mockResolvedValue(null);

    await expect(
      service().listRecommendations("workspace-pk", { bookIds: ["42"] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      recommendations.listRecommendationsByWorkspace,
    ).not.toHaveBeenCalled();
  });
});
