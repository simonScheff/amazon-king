import type { AmazonRegion } from "@amazon-king/contracts";

/**
 * Internal domain models for the Amazon gateway. The rest of the app depends
 * on these shapes only — never on raw Amazon field naming (plan §6, "API
 * version isolation"). Every translated entity keeps its raw payload in
 * `raw` so the database layer can persist it in raw_json for diagnosis.
 */

export type { AmazonRegion };

/** Sponsored Products report types built on stable Reporting v3. */
export type SpReportTypeId =
  "spCampaigns" | "spSearchTerm" | "spTargeting" | "spAdvertisedProduct";

/** An advertiser profile discovered via GET /v2/profiles. */
export interface Profile {
  profileId: string;
  region: AmazonRegion;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  accountId: string | null;
  accountType: string | null;
  accountName: string | null;
}

export interface Campaign {
  campaignId: string;
  name: string;
  state: string;
  dailyBudget: number | null;
  startDate: string | null;
  endDate: string | null;
  targetingType: string | null;
  raw: unknown;
}

export interface AdGroup {
  adGroupId: string;
  campaignId: string;
  name: string;
  state: string;
  defaultBid: number | null;
  raw: unknown;
}

export interface ProductAd {
  adId: string;
  campaignId: string;
  adGroupId: string;
  state: string;
  asin: string | null;
  sku: string | null;
  raw: unknown;
}

export interface Keyword {
  keywordId: string;
  campaignId: string;
  adGroupId: string;
  keywordText: string;
  matchType: string;
  state: string;
  bid: number | null;
  raw: unknown;
}

export interface Target {
  targetId: string;
  campaignId: string;
  adGroupId: string;
  state: string;
  bid: number | null;
  expressionType: string | null;
  raw: unknown;
}

export interface NegativeKeyword {
  negativeKeywordId: string;
  campaignId: string;
  adGroupId: string | null;
  keywordText: string;
  matchType: string;
  state: string;
  raw: unknown;
}

/** Point-in-time copy of a profile's Sponsored Products structure. */
export interface StructureSnapshot {
  profileId: string;
  /** ISO timestamp of when the snapshot was retrieved. */
  retrievedAt: string;
  campaigns: Campaign[];
  adGroups: AdGroup[];
  ads: ProductAd[];
  keywords: Keyword[];
  targets: Target[];
  negativeKeywords: NegativeKeyword[];
}

/** Internal report request; translated to a Reporting v3 body at the boundary. */
export interface ReportSpec {
  reportType: SpReportTypeId;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
  /** Metric column names, e.g. ["impressions", "clicks", "cost", "purchases7d"]. */
  metrics: string[];
  /** Optional override for the report's groupBy dimensions. */
  groupBy?: string[];
}

/** Handle returned right after POST /reporting/reports — no data yet. */
export interface ReportJob {
  reportId: string;
  profileId: string;
  reportType: SpReportTypeId;
  state: "queued";
  /** ISO timestamp of when the report was requested. */
  requestedAt: string;
}

/**
 * Internal report lifecycle (plan §8 state machine), mapped from Amazon's
 * PENDING / PROCESSING / COMPLETED / FAILURE. The two legacy aliases remain
 * accepted so an in-flight report survives Amazon vocabulary changes.
 */
export type ReportState = "queued" | "polling" | "downloading" | "failed";

export interface ReportStatus {
  reportId: string;
  state: ReportState;
  /** Amazon's raw status, kept for diagnosis. */
  amazonStatus:
    | "PENDING"
    | "PROCESSING"
    | "COMPLETED"
    | "FAILURE"
    | "IN_PROGRESS"
    | "SUCCESS";
  /** Pre-signed URL, present only when state === "downloading". Sensitive: never log. */
  downloadUrl?: string;
  failureReason?: string;
}

/** What a profile can do inside this product (SP-only MVP boundary). */
export interface Capabilities {
  profileId: string;
  region: AmazonRegion;
  adProducts: string[];
  reportTypes: SpReportTypeId[];
  writeOperations: ChangeAction["kind"][];
}

/** Lower the keyword bid / change the keyword bid. `bid` is a string-encoded decimal. */
export interface UpdateBidAction {
  actionId: string;
  kind: "update_bid";
  keywordId: string;
  bid: string;
}

/** Add a negative exact keyword at campaign or ad-group level. */
export interface AddNegativeExactAction {
  actionId: string;
  kind: "add_negative_exact";
  campaignId: string;
  /** Omit for a campaign-level negative. */
  adGroupId?: string;
  keywordText: string;
}

export type ChangeAction = UpdateBidAction | AddNegativeExactAction;

/** Immutable, human-approved set of changes to apply. */
export interface ChangeSet {
  changeSetId: string;
  profileId: string;
  actions: ChangeAction[];
}

/** Per-item outcome — a batch HTTP success never implies per-item success. */
export interface ActionResult {
  actionId: string;
  status: "applied" | "failed";
  /** Amazon's per-item code (e.g. "SUCCESS", "INVALID_VALUE"). */
  code: string;
  message?: string;
  /** Amazon entity id when the write created/updated one. */
  amazonEntityId?: string;
}
