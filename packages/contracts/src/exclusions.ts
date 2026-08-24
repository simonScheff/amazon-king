import { z } from "zod";
import { isoDateTimeSchema } from "./common.js";

/**
 * Persistent workspace-level search-term exclusions. Excluding a term records
 * it in the workspace exclusion list and drafts one negative change set per
 * profile covering the enabled campaigns that actually served the term (in any
 * market); the drafts stay approval-gated in Change center, and the worker's
 * enforcement pass covers future campaigns once they start serving the term.
 */

/** One drafted per-profile change set of an exclusion. */
export const searchTermExclusionChangeSetSchema = z.object({
  changeSetId: z.string(),
  /** Amazon profile id (the market the set applies to). */
  profileId: z.string(),
  /** Enabled campaigns in this profile the set blocks the term in. */
  campaignCount: z.number().int().nonnegative(),
});
export type SearchTermExclusionChangeSet = z.infer<
  typeof searchTermExclusionChangeSetSchema
>;

/**
 * POST /api/search-terms/:term/exclusion result. `created` is false when the
 * term was already excluded (the list entry is idempotent; drafting still
 * runs so newly serving campaigns get covered). Only campaigns that actually
 * served the term within the lookback window are drafted for;
 * `skippedCampaigns` counts those serving campaigns that needed no action
 * because they are not enabled or already block the term.
 */
export const searchTermExclusionResultSchema = z.object({
  /** The normalized (trimmed + lowercased) stored term. */
  term: z.string(),
  created: z.boolean(),
  changeSets: z.array(searchTermExclusionChangeSetSchema),
  skippedCampaigns: z.number().int().nonnegative(),
});
export type SearchTermExclusionResult = z.infer<
  typeof searchTermExclusionResultSchema
>;

/**
 * DELETE /api/search-terms/:term/exclusion result. Removing the list entry
 * never pulls negatives already applied on Amazon — re-including those stays
 * the per-campaign negative-removal flow.
 */
export const searchTermExclusionRemovalSchema = z.object({
  removed: z.boolean(),
});
export type SearchTermExclusionRemoval = z.infer<
  typeof searchTermExclusionRemovalSchema
>;

/** One entry of the workspace exclusion list. */
export const searchTermExclusionSchema = z.object({
  term: z.string(),
  createdAt: isoDateTimeSchema,
});
export type SearchTermExclusion = z.infer<typeof searchTermExclusionSchema>;

/** GET /api/search-terms/exclusions result. */
export const searchTermExclusionListSchema = z.object({
  exclusions: z.array(searchTermExclusionSchema),
});
export type SearchTermExclusionList = z.infer<
  typeof searchTermExclusionListSchema
>;
