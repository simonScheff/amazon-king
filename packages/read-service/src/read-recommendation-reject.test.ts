import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger as Logger } from "fastify";
import { recommendations } from "@amazon-king/database";
import type { ApiConfig } from "../config.js";
import { createReadService } from "./read.js";
import type { AuthContext, RequestMeta } from "./types.js";
import { FakeDb } from "../test/fake-db.js";

const META: RequestMeta = { ip: "127.0.0.1", userAgent: "vitest" };
const NOW = new Date("2026-08-18T12:00:00.000Z");

function authFixture(): AuthContext {
  return {
    sessionId: "session-1",
    userId: "1",
    workspaceId: "1",
    email: "owner@example.com",
    sessionTokenHash: "hash-1",
    sessionCreatedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
  };
}

function setup() {
  const db = new FakeDb();
  db.seedWorkspace();
  db.seedUser("owner@example.com");
  const connection = db.seedConnection();
  const profile = db.seedProfile({ connection_id: connection.id });
  const recommendation = db.seedRecommendation({
    profile_id: profile.id,
    type: "cannibalization_conflict",
    campaign_id: null,
    ad_group_id: null,
    target_id: null,
    search_term: "Tractor Colouring Book",
  });
  const service = createReadService({
    db: db as never,
    config: { killSwitch: false } as ApiConfig,
    logger: {} as unknown as Logger,
    now: () => NOW,
  });
  return { db, service, profile, recommendation };
}

describe("rejectRecommendation", () => {
  it("records a dismissal so later runs do not raise the finding again", async () => {
    const { db, service, profile, recommendation } = setup();

    const rejected = await service.rejectRecommendation(
      authFixture(),
      recommendation.id as string,
      META,
    );

    expect(rejected!.state).toBe("rejected");
    expect(db.tables.recommendationDismissals).toHaveLength(1);
    expect(db.tables.recommendationDismissals[0]).toMatchObject({
      profile_id: profile.id,
      type: "cannibalization_conflict",
      // Stored normalized so casing drift between report imports cannot
      // resurrect a dismissed finding.
      search_term: "tractor colouring book",
    });

    const identity = {
      profileId: profile.id as string,
      type: "cannibalization_conflict",
      campaignId: null,
      adGroupId: null,
      targetId: null,
      searchTerm: "tractor colouring book",
    };
    expect(
      await recommendations.activeDismissalExists(db as never, identity, NOW),
    ).toBe(true);
    // Suppression is time-boxed to the longest evidence window.
    expect(
      await recommendations.activeDismissalExists(
        db as never,
        identity,
        new Date(NOW.getTime() + 61 * 86_400_000),
      ),
    ).toBe(false);
  });

  it("does not duplicate the dismissal when the same finding is rejected twice", async () => {
    const { db, service, profile, recommendation } = setup();
    await service.rejectRecommendation(
      authFixture(),
      recommendation.id as string,
      META,
    );

    const second = db.seedRecommendation({
      profile_id: profile.id,
      type: "cannibalization_conflict",
      campaign_id: null,
      ad_group_id: null,
      target_id: null,
      search_term: "tractor colouring book",
    });
    await service.rejectRecommendation(
      authFixture(),
      second.id as string,
      META,
    );

    expect(db.tables.recommendationDismissals).toHaveLength(1);
    expect(db.tables.recommendationDismissals[0]!.recommendation_id).toBe(
      second.id,
    );
  });
});
