import { z } from "zod";
import type { AdsHttpClient, AdsRequestContext } from "../http.js";
import type { OptimizationRule } from "../types.js";
import { parseWith } from "../validate.js";
import { SP_MEDIA_TYPES } from "./sp-media-types.js";

const idField = z.union([z.number(), z.string()]).transform(String);
const ruleSchema = z.looseObject({
  optimizationRuleId: idField,
  ruleName: z.string().optional(),
  name: z.string().optional(),
  ruleCategory: z.string(),
  ruleSubCategory: z.string(),
  status: z.string(),
});
const responseSchema = z.looseObject({
  optimizationRules: z.array(ruleSchema),
  nextToken: z.string().nullish(),
});

/** List every optimization rule scoped to one Sponsored Products campaign. */
export async function listCampaignOptimizationRules(
  http: AdsHttpClient,
  context: AdsRequestContext,
  campaignId: string,
): Promise<OptimizationRule[]> {
  const rules: OptimizationRule[] = [];
  let nextToken: string | undefined;
  do {
    const response = await http.request({
      method: "POST",
      path: "/sp/rules/optimization/search",
      context,
      mediaType: SP_MEDIA_TYPES.optimizationRules,
      body: {
        maxResults: 100,
        campaignFilter: {
          campaignId: {
            filterType: "EXACT_MATCH",
            values: [campaignId],
          },
        },
        // Amazon requires campaign-scoped rule searches to state which rule
        // category is being queried. Max CPC only needs bid-changing rules.
        optimizationRuleFilter: {
          ruleCategory: {
            filterType: "EXACT_MATCH",
            values: ["BID"],
          },
        },
        ...(nextToken ? { nextToken } : {}),
      },
    });
    const page = parseWith(
      responseSchema,
      response.data,
      "POST /sp/rules/optimization/search",
    );
    rules.push(
      ...page.optimizationRules.map((raw) => ({
        optimizationRuleId: raw.optimizationRuleId,
        name: raw.ruleName ?? raw.name ?? `Rule ${raw.optimizationRuleId}`,
        ruleCategory: raw.ruleCategory,
        ruleSubCategory: raw.ruleSubCategory,
        status: raw.status,
        raw: raw as Record<string, unknown>,
      })),
    );
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);
  return rules;
}
