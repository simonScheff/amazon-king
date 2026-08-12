import { z } from "zod";
import { currencyCodeSchema, isoDateTimeSchema } from "./common.js";

/** Login B (Amazon OAuth connection) health for a profile's connection. */
export const amazonConnectionStatusSchema = z.object({
  status: z.enum(["connected", "reconnect_required", "disconnected"]),
  grantedAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
});
export type AmazonConnectionStatus = z.infer<
  typeof amazonConnectionStatusSchema
>;

export const amazonRegionSchema = z.enum(["NA", "EU", "FE"]);
export type AmazonRegion = z.infer<typeof amazonRegionSchema>;

/** An Amazon Ads profile as mirrored into the app. */
export const amazonProfileSchema = z.object({
  profileId: z.string(),
  accountId: z.string().nullable(),
  region: amazonRegionSchema,
  countryCode: z.string(),
  currencyCode: currencyCodeSchema,
  timezone: z.string().nullable(),
  accountType: z.string().nullable(),
  enabled: z.boolean(),
  /** Whether the owner has opted this profile into guarded writes. */
  writeEnabled: z.boolean(),
});
export type AmazonProfile = z.infer<typeof amazonProfileSchema>;

/** Owner-controlled per-profile switches. Writes stay opt-in per profile. */
export const profileUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  writeEnabled: z.boolean().optional(),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/** Response of POST /api/integrations/amazon/start: the browser navigates to `url`. */
export const amazonStartResponseSchema = z.object({
  url: z.string(),
});
export type AmazonStartResponse = z.infer<typeof amazonStartResponseSchema>;
