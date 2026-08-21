import { z } from "zod";
import { isoDateSchema, isoDateTimeSchema } from "./common.js";

export const syncRunKindSchema = z.enum(["structure", "metrics", "backfill"]);
export type SyncRunKind = z.infer<typeof syncRunKindSchema>;

export const syncRunSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  kind: syncRunKindSchema,
  status: z.string(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  error: z.string().nullable(),
});
export type SyncRun = z.infer<typeof syncRunSchema>;

export const reportJobProgressSchema = z.object({
  reportType: z.string(),
  status: z.string(),
  dateStart: isoDateSchema,
  dateEnd: isoDateSchema,
  error: z.string().nullable(),
});
export type ReportJobProgress = z.infer<typeof reportJobProgressSchema>;

export const syncRunSummarySchema = syncRunSchema.extend({
  reports: z.array(reportJobProgressSchema),
});
export type SyncRunSummary = z.infer<typeof syncRunSummarySchema>;

export const dataFreshnessSchema = z.object({
  profileId: z.string(),
  dataset: z.string(),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  completeThrough: isoDateSchema.nullable(),
});
export type DataFreshness = z.infer<typeof dataFreshnessSchema>;

/**
 * FX sync health for the overview's Sync status card
 * (docs/fx-rates-all-market-plan.md, decision 7). Workspace-level: it appears
 * in the response whether or not any market is selected. `stale` is computed
 * server-side: the latest stored fixing is older than the last business day
 * (weekend fixings do not exist, so a Friday fixing is not stale on Sunday).
 */
export const fxRatesStatusSchema = z.object({
  /** Newest stored rate_date; null when no rates have ever been synced. */
  latestRateDate: isoDateSchema.nullable(),
  lastRunState: z.enum(["succeeded", "failed", "running", "never_run"]),
  /** When the last fx_sync run finished; null when it never ran. */
  lastRunAt: isoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  stale: z.boolean(),
});
export type FxRatesStatus = z.infer<typeof fxRatesStatusSchema>;

/** GET /api/system/data-freshness — per-profile freshness plus FX health. */
export const dataFreshnessResponseSchema = z.object({
  profiles: z.array(dataFreshnessSchema),
  fxRates: fxRatesStatusSchema,
});
export type DataFreshnessResponse = z.infer<typeof dataFreshnessResponseSchema>;

/**
 * POST /api/fx-rates/sync — manual FX-rates sync trigger. The response is
 * the same FX status the data-freshness endpoint reports, so the client can
 * render immediately; `queued` is false when a pending or running fx_sync
 * job already existed and the request was deduped instead of duplicated.
 */
export const fxSyncResultSchema = fxRatesStatusSchema.extend({
  queued: z.boolean(),
});
export type FxSyncResult = z.infer<typeof fxSyncResultSchema>;
