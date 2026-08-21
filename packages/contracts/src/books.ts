import { z } from "zod";
import { ASIN_PATTERN } from "./asin.js";
import {
  currencyCodeSchema,
  isoDateSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";

export const goalModeSchema = z.enum([
  "profit",
  "balanced",
  "launch",
  "visibility",
]);
export type GoalMode = z.infer<typeof goalModeSchema>;

export const bookEconomicsSchema = z.object({
  profileId: z.string(),
  effectiveFrom: isoDateSchema,
  currency: currencyCodeSchema,
  listPrice: nonNegativeDecimalStringSchema,
  estimatedRoyaltyPerSale: nonNegativeDecimalStringSchema,
  targetAcos: z.number().min(0).max(1).nullable(),
  goalMode: goalModeSchema,
  maxSpendWithoutSale: nonNegativeDecimalStringSchema.nullable(),
  maxBid: nonNegativeDecimalStringSchema.nullable(),
  maxDailyBudget: nonNegativeDecimalStringSchema.nullable(),
  notes: z.string().nullable(),
});
export type BookEconomics = z.infer<typeof bookEconomicsSchema>;

export const coverImageUrlSchema = z.string().trim().url().max(2048);

export const bookSchema = z.object({
  id: z.string(),
  asin: z.string(),
  title: z.string(),
  format: z.string(),
  status: z.string(),
  coverImageUrl: coverImageUrlSchema.nullable().default(null),
  profileIds: z.array(z.string()).default([]),
  marketplaceAsins: z.array(
    z.object({ profileId: z.string(), asin: z.string() }),
  ),
  economics: z.array(bookEconomicsSchema).default([]),
});
export type Book = z.infer<typeof bookSchema>;

/** An advertised ASIN that has not yet been linked to the workspace catalog. */
export const advertisedBookCandidateSchema = z.object({
  profileId: z.string().min(1),
  asin: z.string().trim().min(1).max(64),
  countryCode: z.string().trim().length(2),
  currencyCode: currencyCodeSchema,
  adCount: z.number().int().nonnegative(),
});
export type AdvertisedBookCandidate = z.infer<
  typeof advertisedBookCandidateSchema
>;

export const bookFormatSchema = z.enum([
  "paperback",
  "hardcover",
  "kindle",
  "other",
]);
export type BookFormat = z.infer<typeof bookFormatSchema>;

/** Confirm catalog metadata and link an advertised ASIN to one or more profiles. */
export const bookMappingInputSchema = z.object({
  profileIds: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .transform((values) => [...new Set(values)]),
  asin: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(500),
  format: bookFormatSchema,
  coverImageUrl: coverImageUrlSchema.optional(),
});
export type BookMappingInput = z.infer<typeof bookMappingInputSchema>;

/**
 * Attach an existing catalog book to one or more marketplaces that do not
 * yet have ads. Owner-confirmed; Amazon validates the ASIN at apply time.
 */
export const bookProfileLinkInputSchema = z.object({
  profileIds: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .transform((values) => [...new Set(values)]),
  asin: z
    .string()
    .trim()
    .regex(ASIN_PATTERN, "Expected a 10-character ASIN (B0… or ISBN-10)")
    .transform((value) => value.toUpperCase()),
});
export type BookProfileLinkInput = z.infer<typeof bookProfileLinkInputSchema>;

/** Set or clear the cover image URL of an already-mapped book. */
export const bookCoverInputSchema = z.object({
  coverImageUrl: coverImageUrlSchema.nullable(),
});
export type BookCoverInput = z.infer<typeof bookCoverInputSchema>;

/**
 * User-entered KDP royalty economics for a book/profile, effective-dated.
 * Money fields are string-encoded decimals; targetAcos is a 0–1 fraction.
 */
export const bookEconomicsInputSchema = z.object({
  profileId: z.string(),
  effectiveFrom: isoDateSchema,
  currency: currencyCodeSchema,
  listPrice: nonNegativeDecimalStringSchema,
  estimatedRoyaltyPerSale: nonNegativeDecimalStringSchema,
  targetAcos: z.number().min(0).max(1).nullable(),
  goalMode: goalModeSchema,
  maxSpendWithoutSale: nonNegativeDecimalStringSchema.optional(),
  maxBid: nonNegativeDecimalStringSchema.optional(),
  maxDailyBudget: nonNegativeDecimalStringSchema.optional(),
  notes: z.string().optional(),
});
export type BookEconomicsInput = z.infer<typeof bookEconomicsInputSchema>;
