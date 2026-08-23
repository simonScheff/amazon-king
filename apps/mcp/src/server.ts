import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  metricWindowSchema,
  recommendationStateSchema,
  recommendationTypeSchema,
} from "@amazon-king/contracts";
import type { ReadService } from "@amazon-king/read-service";
import { z } from "zod";

/**
 * MCP tool surface over the shared read service (docs/mcp-server-plan.md).
 * Read-only by design: every tool takes only the workspace id, so no tool can
 * reach the guarded-write path, Amazon credentials, or another workspace.
 */

export interface McpServerDeps {
  read: ReadService;
  workspaceId: string;
  version?: string;
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
  const { read, workspaceId } = deps;
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
    async () => json(await read.listProfiles(workspaceId)),
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
          workspaceId,
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
        await read.dashboardCountrySpend(workspaceId, days, books, currency),
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
      json(await read.listCampaigns(workspaceId, days, books)),
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
        workspaceId,
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
      json(await read.listSearchTerms(workspaceId, days, books, country)),
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
        workspaceId,
        term,
        days,
        books,
        country,
      );
      return detail ? json(detail) : notFound(`No data for term '${term}'`);
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
    async () => json(await read.listBooks(workspaceId)),
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
        await read.listRecommendations(workspaceId, {
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
    async () => json(await read.listChangeSets(workspaceId)),
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
    async () =>
      json({
        syncs: await read.listSyncRuns(workspaceId),
        freshness: await read.dataFreshness(workspaceId),
      }),
  );

  return server;
}
