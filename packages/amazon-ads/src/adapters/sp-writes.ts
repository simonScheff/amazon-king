import { z } from "zod";
import { parseWith } from "../validate.js";
import type { AdsHttpClient, AdsRequestContext } from "../http.js";
import type {
  ActionResult,
  AddNegativeExactAction,
  RemoveNegativeExactAction,
  UpdateAdGroupDefaultBidAction,
  UpdateBidAction,
  UpdateCampaignBiddingAction,
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

const writeResultItemSchema = z.looseObject({
  code: z.string().optional(),
  errorCode: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
  keywordId: z.union([z.number(), z.string()]).optional(),
  negativeKeywordId: z.union([z.number(), z.string()]).optional(),
  campaignNegativeKeywordId: z.union([z.number(), z.string()]).optional(),
  targetId: z.union([z.number(), z.string()]).optional(),
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
const adGroupWriteResponseSchema = z.looseObject({
  adGroups: writeResultCollectionSchema,
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

function flattenWriteResults(
  collection: z.infer<typeof writeResultCollectionSchema>,
): WriteResultItem[] {
  if (Array.isArray(collection)) return collection;
  return [
    ...collection.success.map((item) => ({ code: "SUCCESS", ...item })),
    ...collection.error.map((item) => ({
      ...item,
      code: item.code ?? item.errorCode ?? "ERROR",
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
    const code = item.code ?? item.errorCode ?? "UNKNOWN";
    const applied = code === "SUCCESS";
    const entityId =
      item.keywordId ??
      item.negativeKeywordId ??
      item.campaignNegativeKeywordId ??
      item.targetId ??
      item.adGroupId ??
      item.campaignId ??
      item.optimizationRuleId;
    return {
      actionId: action.actionId,
      status: applied ? "applied" : "failed",
      code,
      message: item.message,
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
