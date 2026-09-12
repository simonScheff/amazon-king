import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  metricWindowSchema,
  recommendationStateSchema,
  recommendationTypeSchema,
} from "@amazon-king/contracts";
import type { ReadService } from "@amazon-king/read-service";
import type { McpWriteService } from "./write-service.js";
import { z } from "zod";

/**
 * MCP tool surface over the read service and guarded write/draft service.
 */

export interface McpServerDeps {
  read: ReadService;
  workspaceId: string | (() => Promise<string>);
  version?: string;
  write?: McpWriteService;
}

const SEMANTICS =
  "All monetary values are decimal strings in the marketplace's native " +
  "currency. ACoS is ad spend divided by ad-attributed retail revenue — NOT " +
  "author profit; profit figures exist only where KDP royalty economics are " +
  "entered (see list_books). Always tell the user how fresh the data is " +
  "(get_sync_status) when answering questions about performance.";

const daysSchema = metricWindowSchema
  .default(30)
  .describe(
    "Metric window: a number of days (1-90) or 'mtd' for month-to-date.",
  );
const booksSchema = z
  .array(z.string())
  .optional()
  .describe("Restrict to these book ids (from list_books). Omit for all.");
const countrySchema = z
  .string()
  .length(2)
  .toUpperCase()
  .optional()
  .describe("Two-letter marketplace code (e.g. 'US', 'DE').");
const currencySchema = z
  .string()
  .length(3)
  .toUpperCase()
  .optional()
  .describe("ISO currency for converted totals (requires FX rates).");

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function notFound(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

export function buildMcpServer(deps: McpServerDeps): McpServer {
  const { read } = deps;
  const getWorkspaceId =
    typeof deps.workspaceId === "function"
      ? deps.workspaceId
      : async () => deps.workspaceId as string;
  const server = new McpServer({
    name: "amazon-king",
    version: deps.version ?? "0.0.0",
  });

  server.registerTool(
    "list_profiles",
    {
      description:
        "List the connected Amazon Ads profiles (marketplaces) with their " +
        "country, currency, timezone, and write-enabled flag. " +
        SEMANTICS,
      inputSchema: z.object({}),
    },
    async () => json(await read.listProfiles(await getWorkspaceId())),
  );

  server.registerTool(
    "get_dashboard_summary",
    {
      description:
        "Overview KPIs and daily trend: impressions, clicks, spend, ad sales, " +
        "ACoS/ROAS, and royalty-based profit where book economics exist. Use " +
        "country='all' for the FX-converted all-market view. " +
        SEMANTICS,
      inputSchema: z.object({
        days: daysSchema,
        country: z
          .string()
          .min(2)
          .max(3)
          .default("US")
          .describe("Two-letter marketplace code, or 'all' for every market."),
        books: booksSchema,
        currency: currencySchema,
      }),
    },
    async ({ days, country, books, currency }) =>
      json(
        await read.dashboardSummary(
          await getWorkspaceId(),
          days,
          country.toLowerCase() === "all" ? "all" : country.toUpperCase(),
          books,
          currency,
        ),
      ),
  );

  server.registerTool(
    "get_country_spend",
    {
      description:
        "Spend per marketplace for a window, optionally with converted " +
        "totals in a display currency. " +
        SEMANTICS,
      inputSchema: z.object({
        days: daysSchema,
        books: booksSchema,
        currency: currencySchema,
      }),
    },
    async ({ days, books, currency }) =>
      json(
        await read.dashboardCountrySpend(
          await getWorkspaceId(),
          days,
          books,
          currency,
        ),
      ),
  );

  server.registerTool(
    "list_campaigns",
    {
      description:
        "List Sponsored Products campaigns with performance metrics for a " +
        "window (impressions, clicks, spend, sales, ACoS). " +
        SEMANTICS,
      inputSchema: z.object({ days: daysSchema, books: booksSchema }),
    },
    async ({ days, books }) =>
      json(await read.listCampaigns(await getWorkspaceId(), days, books)),
  );

  server.registerTool(
    "get_campaign",
    {
      description:
        "Detail for one campaign: metrics, daily trend, ad groups, targets, " +
        "and negative keywords/targets. Id is the Amazon campaign id from " +
        "list_campaigns. " +
        SEMANTICS,
      inputSchema: z.object({
        campaignId: z.string().min(1),
        days: daysSchema,
        books: booksSchema,
      }),
    },
    async ({ campaignId, days, books }) => {
      const detail = await read.getCampaignDetail(
        await getWorkspaceId(),
        campaignId,
        days,
        books,
      );
      return detail ? json(detail) : notFound(`Unknown campaign ${campaignId}`);
    },
  );

  server.registerTool(
    "list_search_terms",
    {
      description:
        "Shopper search terms with aggregated performance across campaigns — " +
        "the main research surface for finding wasteful or promising terms. " +
        SEMANTICS,
      inputSchema: z.object({
        days: daysSchema,
        books: booksSchema,
        country: countrySchema,
      }),
    },
    async ({ days, books, country }) =>
      json(
        await read.listSearchTerms(
          await getWorkspaceId(),
          days,
          books,
          country,
        ),
      ),
  );

  server.registerTool(
    "get_search_term",
    {
      description:
        "One shopper search term broken down by campaign, with its daily " +
        "trend and whether it is already blocked by a negative. " +
        SEMANTICS,
      inputSchema: z.object({
        term: z.string().min(1),
        days: daysSchema,
        books: booksSchema,
        country: countrySchema,
      }),
    },
    async ({ term, days, books, country }) => {
      const detail = await read.getSearchTermDetail(
        await getWorkspaceId(),
        term,
        days,
        books,
        country,
      );
      return detail ? json(detail) : notFound(`No data for term '${term}'`);
    },
  );

  server.registerTool(
    "list_negatives",
    {
      description:
        "Workspace inventory of synced negative keywords and product ASINs: " +
        "how many campaigns currently block each one, which still serve it, " +
        "and whether it sold before we first saw the negative. " +
        SEMANTICS,
      inputSchema: z.object({
        days: daysSchema,
        books: booksSchema,
        country: countrySchema,
        kind: z
          .enum(["keyword", "product"])
          .optional()
          .describe("Restrict to keyword or product negatives."),
      }),
    },
    async ({ days, books, country, kind }) =>
      json(
        await read.listNegatives(
          await getWorkspaceId(),
          days,
          books,
          country,
          kind,
        ),
      ),
  );

  server.registerTool(
    "get_negative",
    {
      description:
        "One negative keyword or product ASIN: search-term evidence, " +
        "campaigns it is applied on, and campaigns that still serve it. " +
        SEMANTICS,
      inputSchema: z.object({
        kind: z.enum(["keyword", "product"]),
        value: z.string().min(1).describe("Keyword text or ASIN."),
        days: daysSchema,
        books: booksSchema,
        country: countrySchema,
      }),
    },
    async ({ kind, value, days, books, country }) => {
      const detail = await read.getNegativeDetail(
        await getWorkspaceId(),
        kind,
        value,
        days,
        books,
        country,
      );
      return detail
        ? json(detail)
        : notFound(`Unknown ${kind} negative '${value}'`);
    },
  );

  server.registerTool(
    "list_books",
    {
      description:
        "List the author's books with their KDP economics (price, royalty " +
        "per copy, target ACoS) and advertised-product mappings. Economics " +
        "are required before any profit-based reasoning is valid.",
    },
    async () => json(await read.listBooks(await getWorkspaceId())),
  );

  server.registerTool(
    "list_recommendations",
    {
      description:
        "List optimizer recommendations with rationale, evidence window, " +
        "confidence, and rule version. Filter by type (e.g. " +
        "'wasteful_search_term', 'profitable_target') and state ('pending', " +
        "'approved', 'applied', ...). Every recommendation is deterministic " +
        "and expires when its data goes stale.",
      inputSchema: z.object({
        type: recommendationTypeSchema.optional(),
        state: recommendationStateSchema.optional(),
        books: booksSchema,
      }),
    },
    async ({ type, state, books }) =>
      json(
        await read.listRecommendations(await getWorkspaceId(), {
          type,
          state,
          bookIds: books,
        }),
      ),
  );

  server.registerTool(
    "get_recommendation",
    {
      description:
        "Full detail for one recommendation, including its resolution " +
        "context (cannibalization conflicts or conversion evidence) when " +
        "applicable. Ids come from list_recommendations.",
      inputSchema: z.object({ recommendationId: z.string().min(1) }),
    },
    async ({ recommendationId }) => {
      const workspaceId = await getWorkspaceId();
      const recommendation = await read.getRecommendation(
        workspaceId,
        recommendationId,
      );
      if (!recommendation) {
        return notFound(`Unknown recommendation ${recommendationId}`);
      }
      let context: unknown = null;
      if (recommendation.type === "cannibalization_conflict") {
        context = await read.getCannibalizationResolutionContext(
          workspaceId,
          recommendationId,
        );
      } else if (recommendation.type === "high_ctr_poor_conversion") {
        context = await read.getConversionResolutionContext(
          workspaceId,
          recommendationId,
        );
      }
      return json({ recommendation, context });
    },
  );

  server.registerTool(
    "list_change_sets",
    {
      description:
        "List guarded change sets (draft, previewed, applied, failed, ...) — " +
        "the human-approved write pipeline. Read-only here: applying or " +
        "rolling back a change set always requires the owner in the " +
        "dashboard.",
    },
    async () => json(await read.listChangeSets(await getWorkspaceId())),
  );

  server.registerTool(
    "get_sync_status",
    {
      description:
        "Data freshness: recent sync runs per profile and the last successful " +
        "import per dataset, plus FX-rate sync health. Call this before " +
        "drawing conclusions so you can state how current the numbers are.",
      inputSchema: z.object({}),
    },
    async () => {
      const workspaceId = await getWorkspaceId();
      return json({
        syncs: await read.listSyncRuns(workspaceId),
        freshness: await read.dataFreshness(workspaceId),
      });
    },
  );

  if (deps.write) {
    const { write } = deps;

    server.registerTool(
      "create_recommendation_change_set",
      {
        description:
          "Draft a staged change set from pending recommendation IDs for the owner to review and approve in the dashboard.",
        inputSchema: z.object({
          recommendationIds: z
            .array(z.string().min(1))
            .min(1)
            .describe(
              "List of pending recommendation IDs to draft into a change set",
            ),
        }),
      },
      async ({ recommendationIds }) => {
        try {
          const result = await write.createRecommendationChangeSet(
            await getWorkspaceId(),
            recommendationIds,
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    server.registerTool(
      "add_campaign_negatives",
      {
        description:
          "Draft a negative exact keyword or ASIN target change set for a specific campaign.",
        inputSchema: z.object({
          campaignId: z
            .string()
            .min(1)
            .describe("Internal campaign ID or Amazon campaign ID"),
          searchTerms: z
            .array(z.string().min(1))
            .min(1)
            .describe("Search terms or ASINs to block as negative exact"),
        }),
      },
      async ({ campaignId, searchTerms }) => {
        try {
          const result = await write.createCampaignNegativesChangeSet(
            await getWorkspaceId(),
            campaignId,
            searchTerms,
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    server.registerTool(
      "create_search_term_exclusion",
      {
        description:
          "Add a search term to the workspace persistent exclusion list and draft negative exact sets across all serving campaigns.",
        inputSchema: z.object({
          searchTerm: z
            .string()
            .trim()
            .min(1, "Search term cannot be empty")
            .describe("Search term to exclude workspace-wide"),
        }),
      },
      async ({ searchTerm }) => {
        try {
          const result = await write.createSearchTermExclusion(
            await getWorkspaceId(),
            searchTerm,
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    server.registerTool(
      "set_campaign_max_cpc",
      {
        description: "Set the campaign max CPC bid policy.",
        inputSchema: z.object({
          campaignId: z
            .string()
            .min(1)
            .describe("Internal campaign ID or Amazon campaign ID"),
          maxCpc: z
            .string()
            .trim()
            .regex(
              /^\d+(\.\d{1,4})?$/,
              "Max CPC must be a positive decimal string with up to 4 decimal places",
            )
            .refine((val) => Number(val) > 0, "Max CPC must be greater than 0")
            .describe("Target max CPC in decimal string (e.g. '0.36')"),
        }),
      },
      async ({ campaignId, maxCpc }) => {
        try {
          const result = await write.setCampaignMaxCpc(
            await getWorkspaceId(),
            campaignId,
            maxCpc,
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    server.registerTool(
      "update_campaign_state",
      {
        description:
          "Draft a campaign state update (enable or pause a campaign).",
        inputSchema: z.object({
          campaignId: z
            .string()
            .min(1)
            .describe("Internal campaign ID or Amazon campaign ID"),
          state: z
            .enum(["enabled", "paused"])
            .describe("Target state ('enabled' or 'paused')"),
        }),
      },
      async ({ campaignId, state }) => {
        try {
          const result = await write.updateCampaignState(
            await getWorkspaceId(),
            campaignId,
            state,
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    server.registerTool(
      "add_keywords_to_campaign",
      {
        description:
          "Draft a change set to add positive keywords (Exact, Phrase, or Broad) to an existing campaign ad group.",
        inputSchema: z.object({
          campaignId: z
            .string()
            .min(1)
            .describe("Internal campaign ID or Amazon campaign ID"),
          adGroupId: z
            .string()
            .optional()
            .describe(
              "Optional target ad group ID. Defaults to first ad group.",
            ),
          keywords: z
            .array(
              z.object({
                keywordText: z
                  .string()
                  .trim()
                  .min(1, "Keyword text cannot be empty")
                  .describe("Keyword text to add"),
                matchType: z
                  .enum(["EXACT", "PHRASE", "BROAD"])
                  .default("PHRASE")
                  .describe("Match type"),
                bid: z
                  .string()
                  .trim()
                  .regex(
                    /^\d+(\.\d{1,4})?$/,
                    "Bid must be a positive decimal string with up to 4 decimal places",
                  )
                  .refine(
                    (val) => Number(val) > 0,
                    "Bid must be greater than 0",
                  )
                  .optional()
                  .describe("Keyword bid in decimal string (e.g. '0.38')"),
              }),
            )
            .min(1)
            .describe("Keywords to add to the campaign"),
        }),
      },
      async ({ campaignId, adGroupId, keywords }) => {
        try {
          const result = await write.addKeywordsToCampaign(
            await getWorkspaceId(),
            campaignId,
            keywords,
            adGroupId,
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    server.registerTool(
      "set_campaign_placement_multiplier",
      {
        description:
          "Draft a change set to set placement bid multipliers (Top of Search %, Product Pages %, Rest of Search %) for a campaign.",
        inputSchema: z
          .object({
            campaignId: z
              .string()
              .min(1)
              .describe("Internal campaign ID or Amazon campaign ID"),
            topOfSearchPercentage: z
              .number()
              .int("Percentage must be an integer")
              .min(0, "Percentage must be non-negative")
              .max(900, "Percentage must not exceed 900")
              .optional()
              .describe(
                "Top of search (first page) placement multiplier percentage (e.g. 30 for +30%)",
              ),
            productPagePercentage: z
              .number()
              .int("Percentage must be an integer")
              .min(0, "Percentage must be non-negative")
              .max(900, "Percentage must not exceed 900")
              .optional()
              .describe(
                "Product pages placement multiplier percentage (e.g. 10 for +10%)",
              ),
            restOfSearchPercentage: z
              .number()
              .int("Percentage must be an integer")
              .min(0, "Percentage must be non-negative")
              .max(900, "Percentage must not exceed 900")
              .optional()
              .describe("Rest of search placement multiplier percentage"),
          })
          .refine(
            (data) =>
              data.topOfSearchPercentage !== undefined ||
              data.productPagePercentage !== undefined ||
              data.restOfSearchPercentage !== undefined,
            "At least one placement multiplier percentage must be specified",
          ),
      },
      async ({
        campaignId,
        topOfSearchPercentage,
        productPagePercentage,
        restOfSearchPercentage,
      }) => {
        try {
          const result = await write.setCampaignPlacementMultiplier(
            await getWorkspaceId(),
            campaignId,
            {
              topOfSearchPercentage,
              productPagePercentage,
              restOfSearchPercentage,
            },
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    server.registerTool(
      "reject_recommendation",
      {
        description: "Dismiss or reject an advisory recommendation.",
        inputSchema: z.object({
          recommendationId: z
            .string()
            .min(1)
            .describe("Recommendation ID to dismiss/reject"),
          reason: z.string().optional().describe("Optional rejection reason"),
        }),
      },
      async ({ recommendationId, reason }) => {
        try {
          const result = await write.rejectRecommendation(
            await getWorkspaceId(),
            recommendationId,
            reason,
          );
          return json({ success: true, result });
        } catch (error) {
          return notFound(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );
  }

  return server;
}
