import { createHash } from "node:crypto";

/**
 * Deterministic fingerprint/idempotency-key builders (plan §8/§10).
 * Pure functions with no database access so they are unit-testable.
 */

/** Stable JSON: object keys are sorted recursively so key order never matters. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** SHA-256 hex digest of the stable serialization of value. */
export function buildFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex");
}

/** Fingerprint of a Reporting v3 request specification (plan §8 step 1). */
export function buildReportSpecFingerprint(spec: {
  profileId: string;
  reportType: string;
  dateStart: string;
  dateEnd: string;
  columns: readonly string[];
  [key: string]: unknown;
}): string {
  return buildFingerprint({
    ...spec,
    columns: [...spec.columns].sort(),
  });
}

/** Idempotency fingerprint for a change set (immutable, user-approved batch). */
export function buildChangeSetFingerprint(spec: {
  profileId: string;
  creatorUserId: string;
  actions: readonly unknown[];
}): string {
  return buildFingerprint({ kind: "change_set", ...spec });
}

/** Idempotency fingerprint for a single change action. */
export function buildChangeActionFingerprint(spec: {
  changeSetId: string;
  actionType: string;
  targetId?: string | null;
  campaignId?: string | null;
  adGroupId?: string | null;
  searchTerm?: string | null;
  beforeValue?: string | null;
  afterValue?: string | null;
  rollbackOfId?: string | null;
}): string {
  return buildFingerprint({ kind: "change_action", ...spec });
}
