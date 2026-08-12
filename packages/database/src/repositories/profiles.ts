import type { AmazonRegion } from "@amazon-king/contracts";
import type { Db } from "../db.js";

/** Amazon Ads profiles mirrored into the app (plan §7). */

export interface AmazonProfileRow {
  id: string;
  connectionId: string;
  profileId: string;
  accountId: string | null;
  region: AmazonRegion;
  countryCode: string;
  currencyCode: string;
  timezone: string | null;
  accountType: string | null;
  enabled: boolean;
  writeEnabled: boolean;
}

interface ProfileRow {
  id: string;
  connection_id: string;
  profile_id: string;
  account_id: string | null;
  region: AmazonRegion;
  country_code: string;
  currency_code: string;
  timezone: string | null;
  account_type: string | null;
  enabled: boolean;
  write_enabled: boolean;
}

function toProfile(row: ProfileRow): AmazonProfileRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    profileId: row.profile_id,
    accountId: row.account_id,
    region: row.region,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    accountType: row.account_type,
    enabled: row.enabled,
    writeEnabled: row.write_enabled,
  };
}

/** List all profiles belonging to a workspace (via its connections). */
export async function listProfilesByWorkspace(
  db: Db,
  workspaceId: string,
): Promise<AmazonProfileRow[]> {
  const result = await db.query<ProfileRow>(
    `select p.* from amazon_profiles p
     join amazon_connections c on c.id = p.connection_id
     where c.workspace_id = $1
     order by p.id`,
    [workspaceId],
  );
  return result.rows.map(toProfile);
}

/** Enable or disable a profile for syncing. */
export async function setProfileEnabled(
  db: Db,
  profilePk: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update amazon_profiles set enabled = $2 where id = $1 returning id`,
    [profilePk, enabled],
  );
  return result.rowCount === 1;
}

/**
 * Toggle write access for a profile. Writes stay opt-in per profile;
 * enabling writes also requires the profile to be enabled for syncing.
 */
export async function setProfileWriteEnabled(
  db: Db,
  profilePk: string,
  writeEnabled: boolean,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `update amazon_profiles set write_enabled = $2
     where id = $1 and ($2 = false or enabled = true)
     returning id`,
    [profilePk, writeEnabled],
  );
  return result.rowCount === 1;
}

export async function getProfile(
  db: Db,
  profilePk: string,
): Promise<AmazonProfileRow | null> {
  const result = await db.query<ProfileRow>(
    `select * from amazon_profiles where id = $1`,
    [profilePk],
  );
  return result.rows[0] ? toProfile(result.rows[0]) : null;
}

/**
 * Resolve an Amazon profile id (as exposed to the browser) to the mirrored
 * row, scoped to a workspace so profiles of other workspaces are invisible.
 */
export async function findProfileByAmazonId(
  db: Db,
  workspaceId: string,
  amazonProfileId: string,
): Promise<AmazonProfileRow | null> {
  const result = await db.query<ProfileRow>(
    `select p.* from amazon_profiles p
     join amazon_connections c on c.id = p.connection_id
     where c.workspace_id = $1 and p.profile_id = $2`,
    [workspaceId, amazonProfileId],
  );
  return result.rows[0] ? toProfile(result.rows[0]) : null;
}

/** Insert a discovered profile. No-op when the Amazon profile id already exists. */ export async function insertProfile(
  db: Db,
  input: {
    connectionId: string;
    profileId: string;
    accountId?: string | null;
    region: AmazonRegion;
    countryCode: string;
    currencyCode: string;
    timezone?: string | null;
    accountType?: string | null;
  },
): Promise<AmazonProfileRow> {
  const result = await db.query<ProfileRow>(
    `insert into amazon_profiles
       (connection_id, profile_id, account_id, region, country_code, currency_code, timezone, account_type)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (profile_id) do update set profile_id = excluded.profile_id
     returning *`,
    [
      input.connectionId,
      input.profileId,
      input.accountId ?? null,
      input.region,
      input.countryCode,
      input.currencyCode,
      input.timezone ?? null,
      input.accountType ?? null,
    ],
  );
  return toProfile(result.rows[0]!);
}
