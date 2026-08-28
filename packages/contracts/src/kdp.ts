import { z } from "zod";
import {
  currencyCodeSchema,
  decimalStringSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";

/**
 * KDP "Royalties Estimator" workbook import. The browser parses the xlsx into
 * this canonical payload; the server derives royalty-per-copy suggestions from
 * actuals (docs/kdp-royalty-import-plan.md). KDP data carries no ad
 * attribution, so this never touches per-day or per-campaign figures.
 */

export const kdpRoyaltyRowFormatSchema = z.enum([
  "paperback",
  "hardcover",
  "ebook",
]);
export type KdpRoyaltyRowFormat = z.infer<typeof kdpRoyaltyRowFormatSchema>;

/** One transaction row from a royalty sheet. Amounts may be negative (refunds). */
export const kdpRoyaltyRowSchema = z.object({
  format: kdpRoyaltyRowFormatSchema,
  orderDate: isoDateSchema,
  royaltyDate: isoDateSchema,
  asin: z.string().trim().max(64),
  title: z.string().trim().min(1).max(500),
  marketplace: z.string().trim().min(1).max(64),
  royaltyType: z.string().trim().min(1).max(16),
  transactionType: z.string().trim().min(1).max(128),
  netUnits: z.number().int().min(-1000).max(1000),
  royalty: decimalStringSchema,
  currency: currencyCodeSchema,
});
export type KdpRoyaltyRow = z.infer<typeof kdpRoyaltyRowSchema>;

export const KDP_ROYALTY_IMPORT_MAX_ROWS = 20_000;

export const kdpRoyaltyImportInputSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  rows: z.array(kdpRoyaltyRowSchema).min(1).max(KDP_ROYALTY_IMPORT_MAX_ROWS),
});
export type KdpRoyaltyImportInput = z.infer<typeof kdpRoyaltyImportInputSchema>;

/** Why a report row group produced no suggestion. */
export const kdpRoyaltySkipReasonSchema = z.enum([
  "unknown_marketplace",
  "no_ads_profile",
  "asin_not_linked",
  "currency_mismatch",
  "no_standard_rows",
]);
export type KdpRoyaltySkipReason = z.infer<typeof kdpRoyaltySkipReasonSchema>;

export const kdpRoyaltySkippedRowSchema = z.object({
  asin: z.string(),
  title: z.string(),
  marketplace: z.string(),
  reason: kdpRoyaltySkipReasonSchema,
  units: z.number().int(),
});
export type KdpRoyaltySkippedRow = z.infer<typeof kdpRoyaltySkippedRowSchema>;

/**
 * Derived royalty-per-copy for one book × profile. Computed over standard-rate
 * rows only — expanded-distribution sales cannot come from ads. `lowEvidence`
 * (<5 standard units) and `deviationWarning` (>15% from current) are advisory
 * flags for the review UI.
 */
export const kdpRoyaltySuggestionSchema = z.object({
  bookId: z.string(),
  profileId: z.string(),
  title: z.string(),
  countryCode: z.string().length(2),
  currency: currencyCodeSchema,
  currentRoyaltyPerSale: nonNegativeDecimalStringSchema.nullable(),
  suggestedRoyaltyPerSale: nonNegativeDecimalStringSchema,
  standardUnits: z.number().int().nonnegative(),
  expandedUnits: z.number().int().nonnegative(),
  lowEvidence: z.boolean(),
  deviationWarning: z.boolean(),
});
export type KdpRoyaltySuggestion = z.infer<typeof kdpRoyaltySuggestionSchema>;

export const kdpRoyaltyImportSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  rowCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  appliedAt: isoDateTimeSchema.nullable(),
  /** True when the same file content was uploaded before (idempotent replay). */
  alreadyExisted: z.boolean(),
  suggestions: z.array(kdpRoyaltySuggestionSchema),
  skipped: z.array(kdpRoyaltySkippedRowSchema),
});
export type KdpRoyaltyImport = z.infer<typeof kdpRoyaltyImportSchema>;

export const kdpRoyaltyImportSummarySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  rowCount: z.number().int().nonnegative(),
  suggestionCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  appliedAt: isoDateTimeSchema.nullable(),
});
export type KdpRoyaltyImportSummary = z.infer<
  typeof kdpRoyaltyImportSummarySchema
>;

export const kdpRoyaltyApplyInputSchema = z.object({
  selections: z
    .array(
      z.object({
        bookId: z.string().min(1),
        profileId: z.string().min(1),
      }),
    )
    .min(1)
    .max(500),
  /** Defaults to the apply date. */
  effectiveFrom: isoDateSchema.optional(),
});
export type KdpRoyaltyApplyInput = z.infer<typeof kdpRoyaltyApplyInputSchema>;

export const kdpRoyaltyApplySkipSchema = z.object({
  bookId: z.string(),
  profileId: z.string(),
  reason: z.enum(["unknown_selection", "no_existing_economics"]),
});
export type KdpRoyaltyApplySkip = z.infer<typeof kdpRoyaltyApplySkipSchema>;

export const kdpRoyaltyApplyResultSchema = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.array(kdpRoyaltyApplySkipSchema),
});
export type KdpRoyaltyApplyResult = z.infer<typeof kdpRoyaltyApplyResultSchema>;
