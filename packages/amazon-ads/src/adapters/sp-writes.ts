import { z } from "zod";
import { parseWith } from "../validate.js";
import type { AdsHttpClient, AdsRequestContext } from "../http.js";
import type {
  ActionResult,
  AddNegativeExactAction,
  AddNegativeTargetAction,
  CreateAdGroupAction,
  CreateCampaignAction,
  CreateKeywordAction,
  CreateProductAdAction,
  CreateTargetAction,
  RemoveNegativeExactAction,
  UpdateAdGroupDefaultBidAction,
  UpdateBidAction,
  UpdateCampaignBiddingAction,
  UpdateCampaignNameAction,
  UpdateCampaignStateAction,
  UpdateOptimizationRuleAction,
} from "../types.js";
import { SP_MEDIA_TYPES } from "./sp-media-types.js";

/**
 * Sponsored Products v3 write adapter (plan §6, §10). Internal change actions
 * are translated to Amazon request bodies immediately before execution, and
 * Amazon's 207-style per-item results are mapped one-to-one onto internal
 * ActionResults — a batch HTTP success never implies per-item success.
 */

/** Sponsored Products v3 models every entity id as a JSON string. */
function asSpV3Id(id: string): string {
  return id;
}

/** PUT /sp/keywords body for bid updates. */
export function buildKeywordBidUpdateBody(
  actions: UpdateBidAction[],
): Record<string, unknown> {
  return {
    keywords: actions.map((action) => ({
      keywordId: asSpV3Id(action.keywordId),
      bid: Number(action.bid),
      ...(action.state ? { state: action.state } : {}),
    })),
  };
}

export function buildTargetBidUpdateBody(
  actions: UpdateBidAction[],
): Record<string, unknown> {
  return {
    targetingClauses: actions.map((action) => ({
      targetId: asSpV3Id(action.keywordId),
      bid: Number(action.bid),
      ...(action.state ? { state: action.state } : {}),
    })),
  };
}

export function buildAdGroupBidUpdateBody(
  actions: UpdateAdGroupDefaultBidAction[],
): Record<string, unknown> {
  return {
    adGroups: actions.map((action) => ({
      adGroupId: asSpV3Id(action.adGroupId),
      defaultBid: Number(action.bid),
      ...(action.state ? { state: action.state } : {}),
    })),
  };
}

export function buildCampaignBiddingUpdateBody(
  actions: UpdateCampaignBiddingAction[],
): Record<string, unknown> {
  return {
    campaigns: actions.map((action) => ({
      campaignId: asSpV3Id(action.campaignId),
      ...(action.state ? { state: action.state } : {}),
      dynamicBidding: {
        strategy: action.dynamicBidding.strategy,
        ...(action.dynamicBidding.placements.length > 0
          ? {
              placementBidding: action.dynamicBidding.placements.map(
                (item) => ({
                  placement: item.name,
                  percentage: item.percentage,
                }),
              ),
            }
          : {}),
        ...(action.dynamicBidding.audiences.length > 0
          ? {
              shopperCohortBidding: action.dynamicBidding.audiences.map(
                (item) => ({
                  shopperCohortType: item.name,
                  percentage: item.percentage,
                }),
              ),
            }
          : {}),
      },
    })),
  };
}

/** PUT /sp/campaigns body for state (pause/enable) and name updates. */
export function buildCampaignUpdateBody(
  actions: (UpdateCampaignStateAction | UpdateCampaignNameAction)[],
): Record<string, unknown> {
  return {
    campaigns: actions.map((action) => ({
      campaignId: asSpV3Id(action.campaignId),
      ...(action.kind === "update_campaign_state"
        ? { state: asAmazonState(action.state) }
        : {
            name: action.name,
            // Rename carries the current Amazon state through, like bidding.
            ...(action.state ? { state: action.state } : {}),
          }),
    })),
  };
}

export function buildOptimizationRuleUpdateBody(
  actions: UpdateOptimizationRuleAction[],
): Record<string, unknown> {
  return {
    optimizationRules: actions.map((action) => ({
      ...action.rule,
      optimizationRuleId: asSpV3Id(action.optimizationRuleId),
      status: "DISABLED",
    })),
  };
}

/** POST /sp/negativeKeywords body for negative exact additions. */
export function buildNegativeKeywordCreateBody(
  actions: AddNegativeExactAction[],
): Record<string, unknown> {
  return {
    negativeKeywords: actions.map((action) => ({
      campaignId: asSpV3Id(action.campaignId),
      ...(action.adGroupId ? { adGroupId: asSpV3Id(action.adGroupId) } : {}),
      keywordText: action.keywordText,
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    })),
  };
}

/** POST /sp/campaignNegativeKeywords body for campaign-level negatives. */
export function buildCampaignNegativeKeywordCreateBody(
  actions: AddNegativeExactAction[],
): Record<string, unknown> {
  return {
    campaignNegativeKeywords: actions.map((action) => ({
      campaignId: asSpV3Id(action.campaignId),
      keywordText: action.keywordText,
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    })),
  };
}

/** Creation actions carry lowercase states; Amazon expects SP v3 enums. */
function asAmazonState(state: "enabled" | "paused"): "ENABLED" | "PAUSED" {
  return state === "enabled" ? "ENABLED" : "PAUSED";
}

/** A create_ad_group action whose parent campaign id has been resolved. */
export interface ResolvedCreateAdGroupAction extends CreateAdGroupAction {
  resolvedCampaignId: string;
}

/** A create_product_ad action whose parent ids have been resolved. */
export interface ResolvedCreateProductAdAction extends CreateProductAdAction {
  resolvedCampaignId: string;
  resolvedAdGroupId: string;
}

/** A create_keyword action whose parent ids have been resolved. */
export interface ResolvedCreateKeywordAction extends CreateKeywordAction {
  resolvedCampaignId: string;
  resolvedAdGroupId: string;
}

/** A create_target action whose parent ids have been resolved. */
export interface ResolvedCreateTargetAction extends CreateTargetAction {
  resolvedCampaignId: string;
  resolvedAdGroupId: string;
}

/** POST /sp/campaigns body for campaign creation. */
export function buildCampaignCreateBody(
  actions: CreateCampaignAction[],
): Record<string, unknown> {
  return {
    campaigns: actions.map((action) => ({
      name: action.name,
      targetingType: action.targetingType,
      state: asAmazonState(action.state),
      // SP v3 create takes a budget object; a bare `dailyBudget` field is
      // rejected with "Value null at 'campaigns.N.member.budget'".
      budget: { budget: Number(action.dailyBudget), budgetType: "DAILY" },
      startDate: action.startDate,
    })),
  };
}

/** POST /sp/adGroups body for ad group creation. */
export function buildAdGroupCreateBody(
  actions: ResolvedCreateAdGroupAction[],
): Record<string, unknown> {
  return {
    adGroups: actions.map((action) => ({
      campaignId: asSpV3Id(action.resolvedCampaignId),
      name: action.name,
      state: "ENABLED",
      defaultBid: Number(action.defaultBid),
    })),
  };
}

/** POST /sp/productAds body for product ad creation. */
export function buildProductAdCreateBody(
  actions: ResolvedCreateProductAdAction[],
): Record<string, unknown> {
  return {
    productAds: actions.map((action) => ({
      campaignId: asSpV3Id(action.resolvedCampaignId),
      adGroupId: asSpV3Id(action.resolvedAdGroupId),
      asin: action.asin,
      state: asAmazonState(action.state),
    })),
  };
}

/** POST /sp/keywords body for keyword creation. */
export function buildKeywordCreateBody(
  actions: ResolvedCreateKeywordAction[],
): Record<string, unknown> {
  return {
    keywords: actions.map((action) => ({
      campaignId: asSpV3Id(action.resolvedCampaignId),
      adGroupId: asSpV3Id(action.resolvedAdGroupId),
      keywordText: action.keywordText,
      matchType: action.matchType,
      bid: Number(action.bid),
      state: asAmazonState(action.state),
    })),
  };
}

/** POST /sp/targets body for ASIN product-target creation. */
export function buildTargetCreateBody(
  actions: ResolvedCreateTargetAction[],
): Record<string, unknown> {
  return {
    targetingClauses: actions.map((action) => ({
      campaignId: asSpV3Id(action.resolvedCampaignId),
      adGroupId: asSpV3Id(action.resolvedAdGroupId),
      // Required by SP v3 — omitting it is rejected with "Value null at
      // 'targetingClauses.N.member.expressionType'".
      expressionType: "MANUAL",
      expression: [{ type: "ASIN_SAME_AS", value: action.expressionAsin }],
      // Without a bid the target inherits the ad group default bid.
      ...(action.bid !== undefined ? { bid: Number(action.bid) } : {}),
      state: asAmazonState(action.state),
    })),
  };
}

/** POST /sp/campaignNegativeTargets body for campaign-level negative ASIN targets. */
export function buildNegativeTargetCreateBody(
  actions: AddNegativeTargetAction[],
): Record<string, unknown> {
  return {
    campaignNegativeTargetingClauses: actions.map((action) => ({
      campaignId: asSpV3Id(action.campaignId),
      expression: [{ type: "ASIN_SAME_AS", value: action.expressionAsin }],
      state: "ENABLED",
    })),
  };
}

/**
 * Amazon's per-item write errors nest the detail one level down:
 * `{"index":0,"errors":[{"errorType":"otherError","errorValue":{"otherError":
 * {"message":"...","reason":"..."}}}]}` — there is no top-level code/message,
 * so without this shape every failure surfaced as `ERROR` with a null message.
 */
const nestedWriteErrorSchema = z.looseObject({
  errorType: z.string().optional(),
  errorValue: z
    .record(z.string(), z.looseObject({ message: z.string().optional() }))
    .optional(),
});

const writeResultItemSchema = z.looseObject({
  code: z.string().optional(),
  errorCode: z.string().optional(),
  errors: z.array(nestedWriteErrorSchema).optional(),
  index: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
  keywordId: z.union([z.number(), z.string()]).optional(),
  negativeKeywordId: z.union([z.number(), z.string()]).optional(),
  campaignNegativeKeywordId: z.union([z.number(), z.string()]).optional(),
  negativeTargetId: z.union([z.number(), z.string()]).optional(),
  campaignNegativeTargetingClauseId: z
    .union([z.number(), z.string()])
    .optional(),
  targetId: z.union([z.number(), z.string()]).optional(),
  adId: z.union([z.number(), z.string()]).optional(),
  adGroupId: z.union([z.number(), z.string()]).optional(),
  campaignId: z.union([z.number(), z.string()]).optional(),
  optimizationRuleId: z.union([z.number(), z.string()]).optional(),
});

const writeResultCollectionSchema = z.union([
  z.array(writeResultItemSchema),
  z.looseObject({
    success: z.array(writeResultItemSchema).default([]),
    error: z.array(writeResultItemSchema).default([]),
  }),
]);

const keywordWriteResponseSchema = z.looseObject({
  keywords: writeResultCollectionSchema,
});

const negativeKeywordWriteResponseSchema = z.looseObject({
  negativeKeywords: writeResultCollectionSchema,
});

const campaignNegativeKeywordWriteResponseSchema = z.looseObject({
  campaignNegativeKeywords: writeResultCollectionSchema,
});

const targetWriteResponseSchema = z.looseObject({
  targetingClauses: writeResultCollectionSchema,
});
const negativeTargetWriteResponseSchema = z.looseObject({
  campaignNegativeTargetingClauses: writeResultCollectionSchema,
});
const adGroupWriteResponseSchema = z.looseObject({
  adGroups: writeResultCollectionSchema,
});
const productAdWriteResponseSchema = z.looseObject({
  productAds: writeResultCollectionSchema,
});
const campaignWriteResponseSchema = z.looseObject({
  campaigns: writeResultCollectionSchema,
});
const optimizationRuleWriteResponseSchema = z.looseObject({
  responses: z.array(
    z.looseObject({
      code: z.string(),
      details: z.string().optional(),
      optimizationRule: z
        .looseObject({ optimizationRuleId: z.union([z.number(), z.string()]) })
        .optional(),
    }),
  ),
});

type WriteResultItem = z.infer<typeof writeResultItemSchema>;

/** Extract code/message from Amazon's nested per-item error detail. */
function nestedWriteError(item: WriteResultItem): {
  code: string | undefined;
  message: string | undefined;
} {
  const first = item.errors?.[0];
  if (!first) return { code: undefined, message: undefined };
  const detail = first.errorValue
    ? Object.values(first.errorValue)[0]
    : undefined;
  return { code: first.errorType, message: detail?.message };
}

function flattenWriteResults(
  collection: z.infer<typeof writeResultCollectionSchema>,
): WriteResultItem[] {
  if (Array.isArray(collection)) return collection;
  return [
    ...collection.success.map((item) => ({ code: "SUCCESS", ...item })),
    ...collection.error.map((item) => ({
      ...item,
      code:
        item.code ?? item.errorCode ?? nestedWriteError(item).code ?? "ERROR",
    })),
  ];
}

/** Map Amazon's per-item multi-status results onto the originating actions, in order. */
export function mapWriteResults(
  actions: { actionId: string }[],
  items: WriteResultItem[],
): ActionResult[] {
  return actions.map((action, position) => {
    // Prefer Amazon's explicit index; fall back to response order.
    const item =
      items.find((candidate) => candidate.index === position) ??
      items[position];
    if (!item) {
      return {
        actionId: action.actionId,
        status: "failed",
        code: "MISSING_RESULT",
        message: "Amazon returned no per-item result for this action",
      };
    }
    const code =
      item.code ?? item.errorCode ?? nestedWriteError(item).code ?? "UNKNOWN";
    const applied = code === "SUCCESS";
    const entityId =
      item.keywordId ??
      item.negativeKeywordId ??
      item.campaignNegativeKeywordId ??
      item.campaignNegativeTargetingClauseId ??
      item.negativeTargetId ??
      item.targetId ??
      item.adId ??
      item.adGroupId ??
      item.campaignId ??
      item.optimizationRuleId;
    return {
      actionId: action.actionId,
      status: applied ? "applied" : "failed",
      code,
      message: item.message ?? nestedWriteError(item).message,
      amazonEntityId: entityId !== undefined ? String(entityId) : undefined,
    };
  });
}

async function inBatches<T, A extends { actionId: string }>(
  actions: A[],
  run: (batch: A[]) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < actions.length; start += 100) {
    results.push(...(await run(actions.slice(start, start + 100))));
  }
  return results;
}

/** PUT /sp/keywords — apply bid updates, returning per-item results. */
export async function updateKeywordBids(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: UpdateBidAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "PUT",
      path: "/sp/keywords",
      context,
      mediaType: SP_MEDIA_TYPES.keywords,
      body: buildKeywordBidUpdateBody(batch),
    });
    const data = parseWith(
      keywordWriteResponseSchema,
      response.data,
      "PUT /sp/keywords",
    );
    return mapWriteResults(batch, flattenWriteResults(data.keywords));
  });
}

export async function updateTargetBids(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: UpdateBidAction[],
): Promise<ActionResult[]> {
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "PUT",
      path: "/sp/targets",
      context,
      mediaType: SP_MEDIA_TYPES.targets,
      body: buildTargetBidUpdateBody(batch),
    });
    const data = parseWith(
      targetWriteResponseSchema,
      response.data,
      "PUT /sp/targets",
    );
    return mapWriteResults(batch, flattenWriteResults(data.targetingClauses));
  });
}

export async function updateAdGroupDefaultBids(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: UpdateAdGroupDefaultBidAction[],
): Promise<ActionResult[]> {
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "PUT",
      path: "/sp/adGroups",
      context,
      mediaType: SP_MEDIA_TYPES.adGroups,
      body: buildAdGroupBidUpdateBody(batch),
    });
    const data = parseWith(
      adGroupWriteResponseSchema,
      response.data,
      "PUT /sp/adGroups",
    );
    return mapWriteResults(batch, flattenWriteResults(data.adGroups));
  });
}

export async function updateCampaignBidding(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: UpdateCampaignBiddingAction[],
): Promise<ActionResult[]> {
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "PUT",
      path: "/sp/campaigns",
      context,
      mediaType: SP_MEDIA_TYPES.campaigns,
      body: buildCampaignBiddingUpdateBody(batch),
    });
    const data = parseWith(
      campaignWriteResponseSchema,
      response.data,
      "PUT /sp/campaigns",
    );
    return mapWriteResults(batch, flattenWriteResults(data.campaigns));
  });
}

/** PUT /sp/campaigns — pause/enable or rename, returning per-item results. */
export async function updateCampaigns(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: (UpdateCampaignStateAction | UpdateCampaignNameAction)[],
): Promise<ActionResult[]> {
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "PUT",
      path: "/sp/campaigns",
      context,
      mediaType: SP_MEDIA_TYPES.campaigns,
      body: buildCampaignUpdateBody(batch),
    });
    const data = parseWith(
      campaignWriteResponseSchema,
      response.data,
      "PUT /sp/campaigns",
    );
    return mapWriteResults(batch, flattenWriteResults(data.campaigns));
  });
}

export async function disableOptimizationRules(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: UpdateOptimizationRuleAction[],
): Promise<ActionResult[]> {
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "PUT",
      path: "/sp/rules/optimization",
      context,
      mediaType: SP_MEDIA_TYPES.optimizationRules,
      body: buildOptimizationRuleUpdateBody(batch),
    });
    const data = parseWith(
      optimizationRuleWriteResponseSchema,
      response.data,
      "PUT /sp/rules/optimization",
    );
    return mapWriteResults(
      batch,
      data.responses.map((item, index) => ({
        code: item.code,
        index,
        message: item.details,
        optimizationRuleId: item.optimizationRule?.optimizationRuleId,
      })),
    );
  });
}

/** POST /sp/negativeKeywords — create negative exact keywords, returning per-item results. */
export async function createNegativeKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: AddNegativeExactAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  const response = await http.request({
    method: "POST",
    path: "/sp/negativeKeywords",
    context,
    mediaType: SP_MEDIA_TYPES.negativeKeywords,
    body: buildNegativeKeywordCreateBody(actions),
  });
  const data = parseWith(
    negativeKeywordWriteResponseSchema,
    response.data,
    "POST /sp/negativeKeywords",
  );
  return mapWriteResults(actions, flattenWriteResults(data.negativeKeywords));
}

/** POST /sp/campaignNegativeKeywords — create campaign-level negatives. */
export async function createCampaignNegativeKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: AddNegativeExactAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  const response = await http.request({
    method: "POST",
    path: "/sp/campaignNegativeKeywords",
    context,
    mediaType: SP_MEDIA_TYPES.campaignNegativeKeywords,
    body: buildCampaignNegativeKeywordCreateBody(actions),
  });
  const data = parseWith(
    campaignNegativeKeywordWriteResponseSchema,
    response.data,
    "POST /sp/campaignNegativeKeywords",
  );
  return mapWriteResults(
    actions,
    flattenWriteResults(data.campaignNegativeKeywords),
  );
}

/** DELETE /sp/negativeKeywords/delete — body carries the ids to remove. */
export async function deleteNegativeKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: RemoveNegativeExactAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  const response = await http.request({
    method: "POST",
    path: "/sp/negativeKeywords/delete",
    context,
    mediaType: SP_MEDIA_TYPES.negativeKeywords,
    body: {
      negativeKeywordIdFilter: {
        include: actions.map((action) => asSpV3Id(action.negativeKeywordId)),
      },
    },
  });
  const data = parseWith(
    negativeKeywordWriteResponseSchema,
    response.data,
    "POST /sp/negativeKeywords/delete",
  );
  return mapWriteResults(actions, flattenWriteResults(data.negativeKeywords));
}

/** POST /sp/campaignNegativeKeywords/delete — remove campaign negatives. */
export async function deleteCampaignNegativeKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: RemoveNegativeExactAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  const response = await http.request({
    method: "POST",
    path: "/sp/campaignNegativeKeywords/delete",
    context,
    mediaType: SP_MEDIA_TYPES.campaignNegativeKeywords,
    body: {
      campaignNegativeKeywordIdFilter: {
        include: actions.map((action) => asSpV3Id(action.negativeKeywordId)),
      },
    },
  });
  const data = parseWith(
    campaignNegativeKeywordWriteResponseSchema,
    response.data,
    "POST /sp/campaignNegativeKeywords/delete",
  );
  return mapWriteResults(
    actions,
    flattenWriteResults(data.campaignNegativeKeywords),
  );
}

/** POST /sp/campaigns — create campaigns, returning per-item results. */
export async function createCampaigns(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: CreateCampaignAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "POST",
      path: "/sp/campaigns",
      context,
      mediaType: SP_MEDIA_TYPES.campaigns,
      body: buildCampaignCreateBody(batch),
    });
    const data = parseWith(
      campaignWriteResponseSchema,
      response.data,
      "POST /sp/campaigns",
    );
    return mapWriteResults(batch, flattenWriteResults(data.campaigns));
  });
}

/** POST /sp/adGroups — create ad groups, returning per-item results. */
export async function createAdGroups(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: ResolvedCreateAdGroupAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "POST",
      path: "/sp/adGroups",
      context,
      mediaType: SP_MEDIA_TYPES.adGroups,
      body: buildAdGroupCreateBody(batch),
    });
    const data = parseWith(
      adGroupWriteResponseSchema,
      response.data,
      "POST /sp/adGroups",
    );
    return mapWriteResults(batch, flattenWriteResults(data.adGroups));
  });
}

/** POST /sp/productAds — create product ads, returning per-item results. */
export async function createProductAds(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: ResolvedCreateProductAdAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "POST",
      path: "/sp/productAds",
      context,
      mediaType: SP_MEDIA_TYPES.productAds,
      body: buildProductAdCreateBody(batch),
    });
    const data = parseWith(
      productAdWriteResponseSchema,
      response.data,
      "POST /sp/productAds",
    );
    return mapWriteResults(batch, flattenWriteResults(data.productAds));
  });
}

/** POST /sp/keywords — create keywords, returning per-item results. */
export async function createKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: ResolvedCreateKeywordAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "POST",
      path: "/sp/keywords",
      context,
      mediaType: SP_MEDIA_TYPES.keywords,
      body: buildKeywordCreateBody(batch),
    });
    const data = parseWith(
      keywordWriteResponseSchema,
      response.data,
      "POST /sp/keywords",
    );
    return mapWriteResults(batch, flattenWriteResults(data.keywords));
  });
}

/** POST /sp/targets — create ASIN product targets, returning per-item results. */
export async function createTargets(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: ResolvedCreateTargetAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "POST",
      path: "/sp/targets",
      context,
      mediaType: SP_MEDIA_TYPES.targets,
      body: buildTargetCreateBody(batch),
    });
    const data = parseWith(
      targetWriteResponseSchema,
      response.data,
      "POST /sp/targets",
    );
    return mapWriteResults(batch, flattenWriteResults(data.targetingClauses));
  });
}

/** POST /sp/campaignNegativeTargets — create campaign-level negative ASIN targets. */
export async function createNegativeTargets(
  http: AdsHttpClient,
  context: AdsRequestContext,
  actions: AddNegativeTargetAction[],
): Promise<ActionResult[]> {
  if (actions.length === 0) {
    return [];
  }
  return inBatches(actions, async (batch) => {
    const response = await http.request({
      method: "POST",
      path: "/sp/campaignNegativeTargets",
      context,
      mediaType: SP_MEDIA_TYPES.campaignNegativeTargets,
      body: buildNegativeTargetCreateBody(batch),
    });
    const data = parseWith(
      negativeTargetWriteResponseSchema,
      response.data,
      "POST /sp/campaignNegativeTargets",
    );
    return mapWriteResults(
      batch,
      flattenWriteResults(data.campaignNegativeTargetingClauses),
    );
  });
}
