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
  dynamicBidding: CampaignDynamicBidding | null;
  raw: unknown;
}

export type CampaignBiddingStrategy =
  "LEGACY_FOR_SALES" | "AUTO_FOR_SALES" | "MANUAL" | "RULE_BASED";

export interface BidAdjustment {
  name: string;
  percentage: number;
}

export interface CampaignDynamicBidding {
  strategy: CampaignBiddingStrategy;
  placements: BidAdjustment[];
  audiences: BidAdjustment[];
}

export interface OptimizationRule {
  optimizationRuleId: string;
  name: string;
  ruleCategory: string;
  ruleSubCategory: string;
  status: string;
  raw: Record<string, unknown>;
}

/** Complete Amazon-side input surface that can increase CPC for one campaign. */
export interface CampaignBidControls {
  profileId: string;
  retrievedAt: string;
  campaign: Campaign;
  adGroups: AdGroup[];
  keywords: Keyword[];
  targets: Target[];
  optimizationRules: OptimizationRule[];
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

/** One targeting expression predicate, e.g. { type: "ASIN_SAME_AS", value: "B0…" }. */
export interface TargetExpression {
  type: string;
  /** Absent on auto-targeting predicates (e.g. QUERY_HIGH_REL_MATCHES). */
  value?: string;
}

export interface Target {
  targetId: string;
  campaignId: string;
  adGroupId: string;
  state: string;
  bid: number | null;
  expressionType: string | null;
  /** Parsed expression predicates (resolvedExpression preferred over expression). */
  expression?: TargetExpression[];
  raw: unknown;
}

/** A campaign-level negative product target (e.g. an ASIN_SAME_AS exclusion). */
export interface NegativeTarget {
  negativeTargetId: string;
  campaignId: string;
  state: string;
  /** Parsed expression predicates (resolvedExpression preferred over expression). */
  expression: TargetExpression[];
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
  /**
   * Campaign-level negative product targets. Optional so snapshots assembled
   * before this read existed remain valid; the gateway always populates it.
   */
  negativeTargets?: NegativeTarget[];
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
  entityType?: "keyword" | "target";
  bid: string;
  /** Current Amazon state, carried through so a bid-only update cannot change it. */
  state?: string;
}

export interface UpdateAdGroupDefaultBidAction {
  actionId: string;
  kind: "update_ad_group_default_bid";
  adGroupId: string;
  bid: string;
  /** Current Amazon state, carried through so a bid-only update cannot change it. */
  state?: string;
}

export interface UpdateCampaignBiddingAction {
  actionId: string;
  kind: "update_campaign_bidding";
  campaignId: string;
  dynamicBidding: CampaignDynamicBidding;
  /** Current Amazon state, carried through while bidding controls change. */
  state?: string;
}

export interface UpdateOptimizationRuleAction {
  actionId: string;
  kind: "update_optimization_rule";
  optimizationRuleId: string;
  /** Full Amazon rule payload with status changed to DISABLED. */
  rule: Record<string, unknown>;
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

/** Delete the exact negative created by a previously verified action. */
export interface RemoveNegativeExactAction {
  actionId: string;
  kind: "remove_negative_exact";
  negativeKeywordId: string;
  scope: "campaign" | "ad_group";
}

/**
 * Add a campaign-level negative ASIN target — the only way to block
 * product-page placements for a shopper term that is an ASIN.
 */
export interface AddNegativeTargetAction {
  actionId: string;
  kind: "add_negative_target";
  campaignId: string;
  /** ASIN blocked via an ASIN_SAME_AS expression. */
  expressionAsin: string;
}

/** Create a new Sponsored Products campaign (human-approved creation). */
export interface CreateCampaignAction {
  actionId: string;
  kind: "create_campaign";
  name: string;
  /** Daily budget as a string-encoded decimal in the profile's currency. */
  dailyBudget: string;
  targetingType: "AUTO" | "MANUAL";
  /** YYYY-MM-DD. */
  startDate: string;
  state: "enabled" | "paused";
}

/** Create an ad group under a campaign created earlier in the same call. */
export interface CreateAdGroupAction {
  actionId: string;
  kind: "create_ad_group";
  /** actionId of a create_campaign action in the same change set. */
  campaignActionId: string;
  name: string;
  /** Default bid as a string-encoded decimal. */
  defaultBid: string;
}

/** Create a product ad under an ad group created earlier in the same call. */
export interface CreateProductAdAction {
  actionId: string;
  kind: "create_product_ad";
  /** actionId of a create_ad_group action in the same change set. */
  adGroupActionId: string;
  asin: string;
  state: "enabled" | "paused";
}

/** Create a keyword under an ad group created earlier in the same call. */
export interface CreateKeywordAction {
  actionId: string;
  kind: "create_keyword";
  /** actionId of a create_ad_group action in the same change set. */
  adGroupActionId: string;
  keywordText: string;
  matchType: "EXACT" | "PHRASE" | "BROAD";
  /** Bid as a string-encoded decimal. */
  bid: string;
  state: "enabled" | "paused";
}

/** Create an ASIN product target under an ad group created earlier in the same call. */
export interface CreateTargetAction {
  actionId: string;
  kind: "create_target";
  /** actionId of a create_ad_group action in the same change set. */
  adGroupActionId: string;
  /** ASIN targeted via an ASIN_SAME_AS expression. */
  expressionAsin: string;
  /** Bid as a string-encoded decimal; omitted targets inherit the ad group default bid. */
  bid?: string;
  state: "enabled" | "paused";
}

export type ChangeAction =
  | UpdateBidAction
  | UpdateAdGroupDefaultBidAction
  | UpdateCampaignBiddingAction
  | UpdateOptimizationRuleAction
  | AddNegativeExactAction
  | RemoveNegativeExactAction
  | AddNegativeTargetAction
  | CreateCampaignAction
  | CreateAdGroupAction
  | CreateProductAdAction
  | CreateKeywordAction
  | CreateTargetAction;

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
