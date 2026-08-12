import { z } from "zod";
import { parseWith } from "../validate.js";
import type { AdsHttpClient, AdsRequestContext } from "../http.js";
import type {
  ActionResult,
  AddNegativeExactAction,
  UpdateBidAction,
} from "../types.js";
import { SP_MEDIA_TYPES } from "./sp-media-types.js";

/**
 * Sponsored Products v3 write adapter (plan §6, §10). Internal change actions
 * are translated to Amazon request bodies immediately before execution, and
 * Amazon's 207-style per-item results are mapped one-to-one onto internal
 * ActionResults — a batch HTTP success never implies per-item success.
 */

/** Amazon ids are numeric in v3 write bodies; internal models store them as text. */
function asAmazonId(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id;
}

/** PUT /sp/keywords body for bid updates. */
export function buildKeywordBidUpdateBody(
  actions: UpdateBidAction[],
): Record<string, unknown> {
  return {
    keywords: actions.map((action) => ({
      keywordId: asAmazonId(action.keywordId),
      bid: Number(action.bid),
      state: "ENABLED",
    })),
  };
}

/** POST /sp/negativeKeywords body for negative exact additions. */
export function buildNegativeKeywordCreateBody(
  actions: AddNegativeExactAction[],
): Record<string, unknown> {
  return {
    negativeKeywords: actions.map((action) => ({
      campaignId: asAmazonId(action.campaignId),
      ...(action.adGroupId ? { adGroupId: asAmazonId(action.adGroupId) } : {}),
      keywordText: action.keywordText,
      matchType: "NEGATIVE_EXACT",
      state: "ENABLED",
    })),
  };
}

const writeResultItemSchema = z.looseObject({
  code: z.string(),
  index: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
  keywordId: z.union([z.number(), z.string()]).optional(),
  negativeKeywordId: z.union([z.number(), z.string()]).optional(),
});

const keywordWriteResponseSchema = z.looseObject({
  keywords: z.array(writeResultItemSchema),
});

const negativeKeywordWriteResponseSchema = z.looseObject({
  negativeKeywords: z.array(writeResultItemSchema),
});

type WriteResultItem = z.infer<typeof writeResultItemSchema>;

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
    const applied = item.code === "SUCCESS";
    const entityId = item.keywordId ?? item.negativeKeywordId;
    return {
      actionId: action.actionId,
      status: applied ? "applied" : "failed",
      code: item.code,
      message: item.message,
      amazonEntityId: entityId !== undefined ? String(entityId) : undefined,
    };
  });
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
  const response = await http.request({
    method: "PUT",
    path: "/sp/keywords",
    context,
    mediaType: SP_MEDIA_TYPES.keywords,
    body: buildKeywordBidUpdateBody(actions),
  });
  const data = parseWith(
    keywordWriteResponseSchema,
    response.data,
    "PUT /sp/keywords",
  );
  return mapWriteResults(actions, data.keywords);
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
  return mapWriteResults(actions, data.negativeKeywords);
}

/** DELETE /sp/negativeKeywords/delete — body carries the ids to remove. */
export async function deleteNegativeKeywords(
  http: AdsHttpClient,
  context: AdsRequestContext,
  negativeKeywordIds: string[],
): Promise<ActionResult[]> {
  if (negativeKeywordIds.length === 0) {
    return [];
  }
  const response = await http.request({
    method: "POST",
    path: "/sp/negativeKeywords/delete",
    context,
    mediaType: SP_MEDIA_TYPES.negativeKeywords,
    body: { negativeKeywordIds: negativeKeywordIds.map(asAmazonId) },
  });
  const data = parseWith(
    negativeKeywordWriteResponseSchema,
    response.data,
    "POST /sp/negativeKeywords/delete",
  );
  const actions = negativeKeywordIds.map((id) => ({ actionId: id }));
  return mapWriteResults(actions, data.negativeKeywords);
}
