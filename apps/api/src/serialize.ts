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
  return {
    id: row.id,
    profileId: row.amazonProfileId,
    status: row.status,
    createdAt: isoDateTime(row.createdAt),
  };
}

export function toContractChangeAction(
  row: changes.ChangeAction,
): ChangeAction {
  return {
    id: row.id,
    changeSetId: row.changeSetId,
    actionType: row.actionType,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue,
    status: row.status,
    amazonRequestId: row.amazonRequestId,
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
