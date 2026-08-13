import type { Db } from "../db.js";

export interface CampaignBidPolicy {
  campaignId: string;
  maxCpc: string;
  status: "pending" | "active" | "drifted";
  changeSetId: string | null;
  enforcedAt: string | null;
}

interface Row {
  campaign_id: string;
  max_cpc: string;
  status: CampaignBidPolicy["status"];
  change_set_id: string | null;
  enforced_at: string | null;
}

function map(row: Row): CampaignBidPolicy {
  return {
    campaignId: row.campaign_id,
    maxCpc: row.max_cpc,
    status: row.status,
    changeSetId: row.change_set_id,
    enforcedAt: row.enforced_at,
  };
}

export async function getCampaignBidPolicy(
  db: Db,
  campaignId: string,
): Promise<CampaignBidPolicy | null> {
  const result = await db.query<Row>(
    `select campaign_id, max_cpc::text as max_cpc, status, change_set_id, enforced_at
     from campaign_bid_policies where campaign_id = $1`,
    [campaignId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export async function upsertPendingCampaignBidPolicy(
  db: Db,
  input: { campaignId: string; maxCpc: string; changeSetId: string },
): Promise<CampaignBidPolicy> {
  const result = await db.query<Row>(
    `insert into campaign_bid_policies
       (campaign_id, max_cpc, status, change_set_id, enforced_at)
     values ($1, $2, 'pending', $3, null)
     on conflict (campaign_id) do update set
       max_cpc = excluded.max_cpc,
       status = 'pending',
       change_set_id = excluded.change_set_id,
       enforced_at = null,
       updated_at = now()
     returning campaign_id, max_cpc::text as max_cpc, status, change_set_id, enforced_at`,
    [input.campaignId, input.maxCpc, input.changeSetId],
  );
  return map(result.rows[0]!);
}

export async function markCampaignBidPolicy(
  db: Db,
  campaignId: string,
  status: "active" | "drifted",
): Promise<void> {
  await db.query(
    `update campaign_bid_policies set
       status = $2,
       enforced_at = case when $2 = 'active' then now() else enforced_at end,
       updated_at = now()
     where campaign_id = $1`,
    [campaignId, status],
  );
}
