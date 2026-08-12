import { z } from "zod";
import {
  currencyCodeSchema,
  isoDateSchema,
  nonNegativeDecimalStringSchema,
} from "./common.js";

export const bookSchema = z.object({
  id: z.string(),
  asin: z.string(),
  title: z.string(),
  format: z.string(),
  status: z.string(),
});
export type Book = z.infer<typeof bookSchema>;

export const goalModeSchema = z.enum([
  "profit",
  "balanced",
  "launch",
  "visibility",
]);
export type GoalMode = z.infer<typeof goalModeSchema>;

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
