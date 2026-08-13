import { z } from "zod";
import { parseWith } from "../validate.js";
import type { AdsHttpClient, AdsRequestContext } from "../http.js";
import { SP_MEDIA_TYPES } from "./sp-media-types.js";
import type {
  AdGroup,
  Campaign,
  Keyword,
  NegativeKeyword,
  ProductAd,
  Target,
} from "../types.js";

/**
 * Sponsored Products v3 read adapter — paginated /list endpoints translated
 * to internal models (plan §6). Each entity keeps its raw payload in `raw`
 * for raw_json storage. Loose schemas tolerate additive fields.
 */

const idField = z
  .union([z.number(), z.string()])
  .transform((value) => String(value));

const optionalIdField = idField.optional();

const spCampaignSchema = z.looseObject({
  campaignId: idField,
  name: z.string(),
  state: z.string(),
  dailyBudget: z.number().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  targetingType: z.string().optional(),
  dynamicBidding: z
    .looseObject({
      strategy: z.enum([
        "LEGACY_FOR_SALES",
        "AUTO_FOR_SALES",
        "MANUAL",
        "RULE_BASED",
      ]),
      placementBidding: z
        .array(
          z.looseObject({
            placement: z.string(),
            percentage: z.number().int().nonnegative(),
          }),
        )
        .optional(),
      shopperCohortBidding: z
        .array(
          z.looseObject({
            shopperCohortType: z.string().optional(),
            percentage: z.number().int().nonnegative(),
            audienceSegments: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const spAdGroupSchema = z.looseObject({
  adGroupId: idField,
  campaignId: idField,
  name: z.string(),
  state: z.string(),
  defaultBid: z.number().optional(),
});

const spProductAdSchema = z.looseObject({
  adId: idField,
  campaignId: idField,
  adGroupId: idField,
  state: z.string(),
  asin: z.string().optional(),
  sku: z.string().optional(),
});

const spKeywordSchema = z.looseObject({
  keywordId: idField,
  campaignId: idField,
  adGroupId: idField,
  keywordText: z.string(),
  matchType: z.string(),
  state: z.string(),
  bid: z.number().optional(),
});

const spTargetSchema = z.looseObject({
  targetId: idField,
  campaignId: idField,
  adGroupId: idField,
  state: z.string(),
  bid: z.number().optional(),
  expressionType: z.string().optional(),
});

const spNegativeKeywordSchema = z
  .looseObject({
    // SP v3 currently calls this `keywordId`. Accept the older descriptive
    // alias as well so already-captured fixtures remain readable.
    keywordId: idField.optional(),
    negativeKeywordId: idField.optional(),
    campaignId: idField,
    adGroupId: optionalIdField,
    keywordText: z.string(),
    matchType: z.string(),
    state: z.string(),
  })
  .refine(
    (row) => row.keywordId !== undefined || row.negativeKeywordId !== undefined,
    { path: ["keywordId"], message: "Expected Amazon negative keyword id" },
  );

type RawOf<S extends z.ZodType> = z.infer<S>;

function pageSchema<S extends z.ZodType>(key: string, item: S) {
  return z.looseObject({
    [key]: z.array(item),
    nextToken: z.string().optional(),
  });
}

type PageResponse<S extends z.ZodType> = {
  items: RawOf<S>[];
  nextToken?: string;
};

interface PageSpec<S extends z.ZodType> {
  path: string;
  /** Response key holding the item array (e.g. "campaigns"). */
  key: string;
  mediaType: string;
  itemSchema: S;
  /** Extra fields for the POST body (e.g. state filters). */
  body?: Record<string, unknown>;
}

/** Fetch every page of an SP v3 /list endpoint via nextToken pagination. */
async function listAllPages<S extends z.ZodType>(
  http: AdsHttpClient,
  context: AdsRequestContext,
  spec: PageSpec<S>,
): Promise<RawOf<S>[]> {
  const envelope = pageSchema(spec.key, spec.itemSchema);
  const items: RawOf<S>[] = [];
  let nextToken: string | undefined;
  do {
    const response = await http.request({
      method: "POST",
      path: spec.path,
      context,
      mediaType: spec.mediaType,
      body: {
        maxResults: 1000,
        ...spec.body,
        ...(nextToken ? { nextToken } : {}),
      },
    });
    const page = parseWith(
      envelope,
      response.data,
      `POST ${spec.path}`,
    ) as Record<string, unknown> & { nextToken?: string };
    items.push(...(page[spec.key] as RawOf<S>[]));
    nextToken = page.nextToken;
  } while (nextToken);
  return items;
}

export async function listCampaigns(
  http: AdsHttpClient,
  context: AdsRequestContext,
): Promise<Campaign[]> {
  const rows = await listAllPages(http, context, {
    path: "/sp/campaigns/list",
    key: "campaigns",
    mediaType: SP_MEDIA_TYPES.campaigns,
    itemSchema: spCampaignSchema,
  });
  return rows.map((raw) => ({
    campaignId: raw.campaignId,
    name: raw.name,
    state: raw.state,
    dailyBudget: raw.dailyBudget ?? null,
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    targetingType: raw.targetingType ?? null,
    dynamicBidding: raw.dynamicBidding
      ? {
          strategy: raw.dynamicBidding.strategy,
          placements: (raw.dynamicBidding.placementBidding ?? []).map(
            (adjustment) => ({
              name: adjustment.placement,
              percentage: adjustment.percentage,
            }),
          ),
          audiences: (raw.dynamicBidding.shopperCohortBidding ?? []).map(
            (adjustment) => ({
              name:
                adjustment.audienceSegments?.join(", ") ||
                adjustment.shopperCohortType ||
                "Audience",
              percentage: adjustment.percentage,
            }),
          ),
        }
      : null,
    raw,
  }));
}

export async function listAdGroups(
  http: AdsHttpClient,
  context: AdsRequestContext,
): Promise<AdGroup[]> {
  const rows = await listAllPages(http, context, {
    path: "/sp/adGroups/list",
    key: "adGroups",
    mediaType: SP_MEDIA_TYPES.adGroups,
    itemSchema: spAdGroupSchema,
  });
  return rows.map((raw) => ({
    adGroupId: raw.adGroupId,
    campaignId: raw.campaignId,
    name: raw.name,
    state: raw.state,
    defaultBid: raw.defaultBid ?? null,
    raw,
  }));
}

export async function listProductAds(
  http: AdsHttpClient,
  context: AdsRequestContext,
): Promise<ProductAd[]> {
  const rows = await listAllPages(http, context, {
    path: "/sp/productAds/list",
    key: "productAds",
    mediaType: SP_MEDIA_TYPES.productAds,
    itemSchema: spProductAdSchema,
  });
  return rows.map((raw) => ({
    adId: raw.adId,
    campaignId: raw.campaignId,
    adGroupId: raw.adGroupId,
    state: raw.state,
    asin: raw.asin ?? null,
    sku: raw.sku ?? null,
    raw,
  }));
}

export async function listKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
): Promise<Keyword[]> {
  const rows = await listAllPages(http, context, {
    path: "/sp/keywords/list",
    key: "keywords",
    mediaType: SP_MEDIA_TYPES.keywords,
    itemSchema: spKeywordSchema,
  });
  return rows.map((raw) => ({
    keywordId: raw.keywordId,
    campaignId: raw.campaignId,
    adGroupId: raw.adGroupId,
    keywordText: raw.keywordText,
    matchType: raw.matchType,
    state: raw.state,
    bid: raw.bid ?? null,
    raw,
  }));
}

export async function listTargets(
  http: AdsHttpClient,
  context: AdsRequestContext,
): Promise<Target[]> {
  const rows = await listAllPages(http, context, {
    path: "/sp/targets/list",
    // The SP v3 targeting-clause endpoint uses this envelope name even
    // though the resource path and our internal model call them targets.
    key: "targetingClauses",
    mediaType: SP_MEDIA_TYPES.targets,
    itemSchema: spTargetSchema,
  });
  return rows.map((raw) => ({
    targetId: raw.targetId,
    campaignId: raw.campaignId,
    adGroupId: raw.adGroupId,
    state: raw.state,
    bid: raw.bid ?? null,
    expressionType: raw.expressionType ?? null,
    raw,
  }));
}

/** List both campaign- and ad-group-level negative keywords. */
export async function listNegativeKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
): Promise<NegativeKeyword[]> {
  const [adGroupRows, campaignRows] = await Promise.all([
    listAllPages(http, context, {
      path: "/sp/negativeKeywords/list",
      key: "negativeKeywords",
      mediaType: SP_MEDIA_TYPES.negativeKeywords,
      itemSchema: spNegativeKeywordSchema,
    }),
    listAllPages(http, context, {
      path: "/sp/campaignNegativeKeywords/list",
      key: "campaignNegativeKeywords",
      mediaType: SP_MEDIA_TYPES.campaignNegativeKeywords,
      itemSchema: spNegativeKeywordSchema,
    }),
  ]);
  return [...adGroupRows, ...campaignRows].map((raw) => ({
    negativeKeywordId: raw.keywordId ?? (raw.negativeKeywordId as string),
    campaignId: raw.campaignId,
    adGroupId: raw.adGroupId ?? null,
    keywordText: raw.keywordText,
    matchType: raw.matchType,
    state: raw.state,
    raw,
  }));
}
