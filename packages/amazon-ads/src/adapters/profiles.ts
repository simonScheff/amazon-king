import { z } from "zod";
import { currencyCodeSchema } from "@amazon-king/contracts";
import { parseWith } from "../validate.js";
import { ALL_REGIONS, type AdsHttpClient } from "../http.js";
import type { AmazonRegion, Profile } from "../types.js";

/**
 * Profile discovery adapter — GET /v2/profiles on every regional host
 * (plan §5 step 5). Loose schemas tolerate additive Amazon fields; missing or
 * wrong-typed required fields fail with AdapterValidationError.
 */

const amazonProfileSchema = z.looseObject({
  profileId: z.union([z.number(), z.string()]).transform((v) => String(v)),
  countryCode: z.string().min(2),
  currencyCode: currencyCodeSchema,
  timezone: z.string(),
  accountInfo: z.looseObject({
    marketplaceStringId: z.string().optional(),
    id: z
      .union([z.number(), z.string()])
      .transform((v) => String(v))
      .optional(),
    type: z.string(),
    name: z.string().optional(),
  }),
});

const profilesResponseSchema = z.array(amazonProfileSchema);

/** Translate a validated Amazon profile payload into the internal Profile model. */
export function translateProfile(
  raw: z.infer<typeof amazonProfileSchema>,
  region: AmazonRegion,
): Profile {
  return {
    profileId: raw.profileId,
    region,
    countryCode: raw.countryCode,
    currencyCode: raw.currencyCode,
    timezone: raw.timezone,
    accountId: raw.accountInfo.id ?? null,
    accountType: raw.accountInfo.type,
    accountName: raw.accountInfo.name ?? null,
  };
}

/** List profiles on one regional host. */
export async function listProfilesInRegion(
  http: AdsHttpClient,
  accessToken: string,
  region: AmazonRegion,
): Promise<Profile[]> {
  const response = await http.request({
    method: "GET",
    path: "/v2/profiles",
    context: { region, accessToken },
  });
  const rows = parseWith(
    profilesResponseSchema,
    response.data,
    `GET /v2/profiles (${region})`,
  );
  return rows.map((row) => translateProfile(row, region));
}

/** List profiles across all regional hosts; an identity can have profiles in several regions. */
export async function listAllProfiles(
  http: AdsHttpClient,
  accessToken: string,
  regions: AmazonRegion[] = ALL_REGIONS,
): Promise<Profile[]> {
  const profiles: Profile[] = [];
  for (const region of regions) {
    profiles.push(...(await listProfilesInRegion(http, accessToken, region)));
  }
  return profiles;
}
