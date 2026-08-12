import { z } from "zod";
import { parseWith } from "../validate.js";
import type { AdsHttpClient, AdsRequestContext } from "../http.js";
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

const spNegativeKeywordSchema = z.looseObject({
  negativeKeywordId: idField,
  campaignId: idField,
  adGroupId: optionalIdField,
  keywordText: z.string(),
  matchType: z.string(),
  state: z.string(),
});

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
    key: "targets",
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

/** POST /sp/negativeKeywords/list — both campaign- and ad-group-level negatives. */
export async function listNegativeKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
): Promise<NegativeKeyword[]> {
  const rows = await listAllPages(http, context, {
    path: "/sp/negativeKeywords/list",
    key: "negativeKeywords",
    itemSchema: spNegativeKeywordSchema,
  });
  return rows.map((raw) => ({
    negativeKeywordId: raw.negativeKeywordId,
    campaignId: raw.campaignId,
    adGroupId: raw.adGroupId ?? null,
    keywordText: raw.keywordText,
    matchType: raw.matchType,
    state: raw.state,
    raw,
  }));
}
