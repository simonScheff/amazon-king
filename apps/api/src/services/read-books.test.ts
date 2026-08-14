import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger as Logger } from "fastify";
import type { ApiConfig } from "../config.js";
import type { AuthContext } from "./types.js";
import { createReadService } from "./read.js";

const auth: AuthContext = {
  sessionId: "session-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  email: "owner@example.com",
  sessionTokenHash: "hash",
  sessionCreatedAt: new Date("2026-08-13T00:00:00Z"),
  expiresAt: new Date("2026-08-14T00:00:00Z"),
};

function profileRow(id: string, profileId: string) {
  return {
    id,
    connection_id: "connection-1",
    profile_id: profileId,
    account_id: null,
    region: "NA",
    country_code: "US",
    currency_code: "USD",
    timezone: null,
    account_type: null,
    enabled: true,
    write_enabled: false,
  };
}

describe("read service book mapping", () => {
  it("scopes profiles to the workspace and audits an idempotent mapping", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("where c.workspace_id = $1 and p.profile_id = $2")) {
        const row =
          params[1] === "profile-us"
            ? profileRow("101", "profile-us")
            : profileRow("102", "profile-ca");
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("with candidate_profiles as")) {
        expect(params).toEqual([
          "workspace-1",
          ["101", "102"],
          "B012345678",
          "My Coloring Book",
          "paperback",
          null,
        ]);
        return {
          rows: [
            {
              id: "book-1",
              workspace_id: "workspace-1",
              asin: "B012345678",
              title: "My Coloring Book",
              format: "paperback",
              status: "active",
              cover_json: null,
              created_at: "2026-08-13T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("insert into audit_events")) {
        return {
          rows: [
            {
              id: "audit-1",
              workspace_id: "workspace-1",
              actor_user_id: "user-1",
              event: "books.map_advertised_asin",
              entity_type: "book",
              entity_id: "book-1",
              ip: "127.0.0.1",
              session_id: "session-1",
              details: {},
              created_at: "2026-08-13T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = createReadService({
      db: { query } as never,
      config: {} as ApiConfig,
      logger: {} as Logger,
    });

    await expect(
      service.mapAdvertisedProduct(
        auth,
        {
          profileIds: ["profile-us", "profile-ca"],
          asin: "B012345678",
          title: "My Coloring Book",
          format: "paperback",
        },
        { ip: "127.0.0.1" },
      ),
    ).resolves.toEqual({
      id: "book-1",
      asin: "B012345678",
      title: "My Coloring Book",
      format: "paperback",
      status: "active",
      coverImageUrl: null,
      profileIds: ["profile-us", "profile-ca"],
      economics: [],
    });

    const auditCall = query.mock.calls.find(([sql]) =>
      sql.includes("insert into audit_events"),
    );
    expect(JSON.parse(auditCall?.[1]?.[7] as string)).toEqual({
      asin: "B012345678",
      profileIds: ["profile-us", "profile-ca"],
      format: "paperback",
      coverImageUrl: null,
    });
  });

  it("returns the latest saved economics with each mapped book", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from books b")) {
        return {
          rows: [
            {
              id: "book-1",
              workspace_id: "workspace-1",
              asin: "B012345678",
              title: "My Coloring Book",
              format: "paperback",
              status: "active",
              cover_json: null,
              profile_ids: ["profile-ca", "profile-us"],
              created_at: "2026-08-13T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("select distinct on (be.book_id, be.profile_id)")) {
        return {
          rows: [
            {
              id: "economics-1",
              book_id: "book-1",
              profile_id: "101",
              amazon_profile_id: "profile-ca",
              effective_from: "2026-08-13",
              currency: "CAD",
              list_price: "14.2100",
              estimated_royalty_per_sale: "5.0000",
              target_acos: null,
              goal_mode: "balanced",
              max_spend_without_sale: null,
              max_bid: null,
              max_daily_budget: null,
              notes: "",
              created_at: "2026-08-13T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = createReadService({
      db: { query } as never,
      config: {} as ApiConfig,
      logger: {} as Logger,
    });

    await expect(service.listBooks("workspace-1")).resolves.toEqual([
      {
        id: "book-1",
        asin: "B012345678",
        title: "My Coloring Book",
        format: "paperback",
        status: "active",
        coverImageUrl: null,
        profileIds: ["profile-ca", "profile-us"],
        economics: [
          {
            profileId: "profile-ca",
            effectiveFrom: "2026-08-13",
            currency: "CAD",
            listPrice: "14.2100",
            estimatedRoyaltyPerSale: "5.0000",
            targetAcos: null,
            goalMode: "balanced",
            maxSpendWithoutSale: null,
            maxBid: null,
            maxDailyBudget: null,
            notes: "",
          },
        ],
      },
    ]);
  });

  it("rejects economics for a profile that is not linked to the book", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("select * from books where id = $1")) {
        return {
          rows: [
            {
              id: params[0],
              workspace_id: "workspace-1",
              asin: "B012345678",
              title: "My Coloring Book",
              format: "paperback",
              status: "active",
              cover_json: null,
              created_at: "2026-08-13T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("where c.workspace_id = $1 and p.profile_id = $2")) {
        return { rows: [profileRow("101", "profile-us")], rowCount: 1 };
      }
      if (sql.includes("select exists (")) {
        return { rows: [{ linked: false }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = createReadService({
      db: { query } as never,
      config: {} as ApiConfig,
      logger: {} as Logger,
    });

    await expect(
      service.saveBookEconomics(
        auth,
        "book-1",
        {
          profileId: "profile-us",
          effectiveFrom: "2026-08-13",
          currency: "USD",
          listPrice: "9.99",
          estimatedRoyaltyPerSale: "2.04",
          targetAcos: 0.2,
          goalMode: "profit",
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "BOOK_PROFILE_NOT_LINKED" });
  });

  it("sets and clears the cover image and audits the change", async () => {
    const updatedCovers: (string | null)[] = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("select * from books where id = $1")) {
        return {
          rows: [
            {
              id: params[0],
              workspace_id: "workspace-1",
              asin: "B012345678",
              title: "My Coloring Book",
              format: "paperback",
              status: "active",
              cover_json: null,
              created_at: "2026-08-13T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("update books set")) {
        updatedCovers.push(params[4] as string | null);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into audit_events")) {
        return {
          rows: [
            {
              id: "audit-1",
              workspace_id: "workspace-1",
              actor_user_id: "user-1",
              event: "books.cover",
              entity_type: "book",
              entity_id: "book-1",
              ip: "127.0.0.1",
              session_id: "session-1",
              details: {},
              created_at: "2026-08-13T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = createReadService({
      db: { query } as never,
      config: {} as ApiConfig,
      logger: {} as Logger,
    });

    await service.saveBookCover(
      auth,
      "book-1",
      { coverImageUrl: "https://example.com/cover.jpg" },
      { ip: "127.0.0.1" },
    );
    await service.saveBookCover(
      auth,
      "book-1",
      { coverImageUrl: null },
      { ip: "127.0.0.1" },
    );

    expect(updatedCovers).toEqual([
      JSON.stringify({ imageUrl: "https://example.com/cover.jpg" }),
      null,
    ]);
    const auditEvents = query.mock.calls
      .filter(([sql]) => sql.includes("insert into audit_events"))
      .map((call) => JSON.parse(call[1]?.[7] as string));
    expect(auditEvents).toEqual([
      { coverImageUrl: "https://example.com/cover.jpg" },
      { coverImageUrl: null },
    ]);
  });

  it("rejects cover updates for a book outside the workspace", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select * from books where id = $1")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = createReadService({
      db: { query } as never,
      config: {} as ApiConfig,
      logger: {} as Logger,
    });

    await expect(
      service.saveBookCover(
        auth,
        "book-9",
        { coverImageUrl: "https://example.com/cover.jpg" },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
