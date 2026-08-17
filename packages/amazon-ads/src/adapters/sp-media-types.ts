/**
 * Sponsored Products v3 is versioned through vendor media types rather than
 * URL paths. Amazon requires these values in both Accept and Content-Type.
 */
export const SP_MEDIA_TYPES = {
  campaigns: "application/vnd.spcampaign.v3+json",
  adGroups: "application/vnd.spadGroup.v3+json",
  productAds: "application/vnd.spproductAd.v3+json",
  keywords: "application/vnd.spkeyword.v3+json",
  targets: "application/vnd.sptargetingClause.v3+json",
  negativeTargets: "application/vnd.spNegativeTargetingClause.v3+json",
  campaignNegativeTargets:
    "application/vnd.spCampaignNegativeTargetingClause.v3+json",
  negativeKeywords: "application/vnd.spnegativeKeyword.v3+json",
  campaignNegativeKeywords: "application/vnd.spCampaignNegativeKeyword.v3+json",
  optimizationRules: "application/vnd.spoptimizationrules.v2+json",
} as const;
