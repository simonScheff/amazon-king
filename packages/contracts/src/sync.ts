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

export const dataFreshnessSchema = z.object({
  profileId: z.string(),
  dataset: z.string(),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  completeThrough: isoDateSchema.nullable(),
});
export type DataFreshness = z.infer<typeof dataFreshnessSchema>;
