import type {
  AmazonProfile,
  AuditEvent,
  ChangeAction,
  ChangeSet,
  Recommendation,
  SyncRun,
} from "@amazon-king/contracts";
import type {
  audit,
  changes,
  profiles,
  recommendations,
  reports,
} from "@amazon-king/database";

/** Map DB rows to contract payloads. Money stays string-encoded; dates are ISO. */

/** pg returns timestamptz as Date and date as "YYYY-MM-DD" string; normalize. */
export function isoDateTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Keep date-only contract fields stable even when a driver returns a Date. */
export function isoDate(value: string | Date): string {
  if (!(value instanceof Date)) {
    return value.slice(0, 10);
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Campaign Manager URL for a profile in the Amazon Ads console, anchored on
 * the profile's entity id (`accountInfo.id` from the profiles API) so it
 * opens the right marketplace. A per-campaign deep link is not possible: the
 * console uses its own id namespace (the `A…` ids in its URLs) that the API
 * never exposes and that cannot be derived from the API's numeric campaign
 * id (see amzn/ads-advanced-tools-docs discussion #14). Null when the
 * profile row has no entity id yet.
 */
export function amazonConsoleUrl(accountId: string | null): string | null {
  if (!accountId) return null;
  return `https://advertising.amazon.com/cm/campaigns?entityId=${encodeURIComponent(accountId)}`;
}

export function toContractProfile(
  row: profiles.AmazonProfileRow,
): AmazonProfile {
  return {
    profileId: row.profileId,
    accountId: row.accountId,
    region: row.region,
    countryCode: row.countryCode,
    currencyCode: row.currencyCode,
    timezone: row.timezone,
    accountType: row.accountType,
    enabled: row.enabled,
    writeEnabled: row.writeEnabled,
  };
}

export function toContractRecommendation(
  row: recommendations.RecommendationWithProfile,
): Recommendation {
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    priority: row.priority,
    profileId: row.amazonProfileId,
    campaignId: row.campaignId,
    campaign: row.amazonCampaignId
      ? {
          campaignId: row.amazonCampaignId,
          name: row.campaignName ?? row.amazonCampaignId,
          state: row.campaignState ?? "unknown",
        }
      : null,
    adGroupId: row.adGroupId,
    targetId: row.targetId,
    searchTerm: row.searchTerm,
    currentValue: row.currentValue,
    proposedValue: row.proposedValue,
    rationale: row.rationale,
    confidence: Number(row.confidence),
    evidenceWindow: {
      start: isoDate(row.evidenceWindowStart),
      end: isoDate(row.evidenceWindowEnd),
    },
    dataFreshness: isoDateTime(row.dataFreshnessAt),
    ruleVersion: row.ruleVersion,
    expiresAt: isoDateTime(row.expiresAt),
    createdAt: isoDateTime(row.createdAt),
  };
}

export function toContractChangeSet(
  row: changes.ChangeSetWithProfile,
): ChangeSet {
  const dependsOnChangeSetId = row.metadata.dependsOnChangeSetId;
  return {
    id: row.id,
    profileId: row.amazonProfileId,
    status: row.status,
    createdAt: isoDateTime(row.createdAt),
    kind: row.kind,
    dependsOnChangeSetId:
      typeof dependsOnChangeSetId === "string" ? dependsOnChangeSetId : null,
  };
}

/** Render the before/after detail for campaign attribute update actions. */
function campaignUpdateDetail(state: unknown): string | null {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const record = state as Record<string, unknown>;
  if (typeof record.state === "string") return `State: ${record.state}`;
  if (typeof record.name === "string") return record.name;
  return null;
}

const CAMPAIGN_UPDATE_TYPES = new Set([
  "update_campaign_state",
  "update_campaign_name",
]);

export function toContractChangeAction(
  row: changes.ChangeAction,
): ChangeAction {
  const amazonResponse =
    row.amazonResponse !== null &&
    typeof row.amazonResponse === "object" &&
    !Array.isArray(row.amazonResponse)
      ? (row.amazonResponse as Record<string, unknown>)
      : null;
  const amazonDetails =
    amazonResponse?.details !== null &&
    typeof amazonResponse?.details === "object" &&
    !Array.isArray(amazonResponse.details)
      ? (amazonResponse.details as Record<string, unknown>)
      : null;
  const baseError =
    typeof amazonResponse?.message === "string" ? amazonResponse.message : null;
  const detailError =
    typeof amazonDetails?.Message === "string"
      ? amazonDetails.Message
      : typeof amazonDetails?.message === "string"
        ? amazonDetails.message
        : null;
  return {
    id: row.id,
    changeSetId: row.changeSetId,
    actionType: row.actionType,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    entityName: row.entityName,
    searchTerm: row.searchTerm,
    campaignName: row.campaignName,
    amazonCampaignId: row.amazonCampaignId,
    beforeDetail: CAMPAIGN_UPDATE_TYPES.has(row.actionType)
      ? campaignUpdateDetail(row.beforeState)
      : row.actionType === "add_negative_exact"
        ? "No matching campaign negative exact"
        : row.actionType === "add_negative_target"
          ? "No matching campaign negative ASIN target"
          : row.actionType === "remove_negative_exact"
            ? "Negative exact enabled"
            : row.actionType === "update_campaign_bidding"
              ? "Current strategy and bid adjustments"
              : row.actionType === "update_optimization_rule"
                ? "Rule enabled"
                : row.actionType === "create_campaign"
                  ? "No campaign"
                  : row.actionType === "create_ad_group"
                    ? "No ad group"
                    : row.actionType === "create_product_ad"
                      ? "No product ad"
                      : row.actionType === "create_keyword"
                        ? "No keyword"
                        : row.actionType === "create_target"
                          ? "No product target"
                          : null,
    afterDetail: CAMPAIGN_UPDATE_TYPES.has(row.actionType)
      ? campaignUpdateDetail(row.afterState)
      : row.actionType === "add_negative_exact"
        ? "Campaign-level negative exact enabled"
        : row.actionType === "add_negative_target"
          ? "Campaign-level negative ASIN target enabled"
          : row.actionType === "remove_negative_exact"
            ? "Negative exact removed"
            : row.actionType === "update_campaign_bidding"
              ? "Down only; placement and audience adjustments removed"
              : row.actionType === "update_optimization_rule"
                ? "Rule disabled"
                : row.actionType === "create_campaign"
                  ? "Campaign created"
                  : row.actionType === "create_ad_group"
                    ? "Ad group created"
                    : row.actionType === "create_product_ad"
                      ? "Product ad created"
                      : row.actionType === "create_keyword"
                        ? "Keyword created"
                        : row.actionType === "create_target"
                          ? "Product target created"
                          : null,
    rollbackAvailable:
      (row.actionType === "update_bid" && row.beforeValue !== null) ||
      (row.actionType === "add_negative_exact" &&
        row.amazonEntityId !== null) ||
      CAMPAIGN_UPDATE_TYPES.has(row.actionType),
    status: row.status,
    amazonRequestId: row.amazonRequestId,
    errorMessage:
      baseError && detailError ? `${baseError}: ${detailError}` : baseError,
  };
}

export function toContractSyncRun(
  row: reports.SyncRun,
  amazonProfileId: string,
): SyncRun {
  return {
    id: row.id,
    profileId: amazonProfileId,
    kind: row.kind,
    status: row.status,
    startedAt: isoDateTime(row.startedAt),
    finishedAt: row.finishedAt ? isoDateTime(row.finishedAt) : null,
    error: row.error,
  };
}

export function toContractAuditEvent(row: audit.AuditEvent): AuditEvent {
  return {
    id: row.id,
    actor: row.actorUserId ?? "system",
    event: row.event,
    entityType: row.entityType,
    entityId: row.entityId,
    createdAt: isoDateTime(row.createdAt),
    details: row.details,
  };
}
