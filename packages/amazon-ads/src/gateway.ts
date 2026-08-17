import { defaultLogger, type LoggerLike } from "./logger.js";
import {
  createAdsHttpClient,
  type AdsHttpClient,
  type AdsRequestContext,
} from "./http.js";
import type { TokenManager } from "./token-manager.js";
import { listAllProfiles } from "./adapters/profiles.js";
import { getReportStatus, requestReport } from "./adapters/reporting.js";
import {
  listAdGroups,
  listCampaigns,
  listKeywords,
  listNegativeKeywords,
  listNegativeTargets,
  listProductAds,
  listTargets,
} from "./adapters/sp-campaigns.js";
import { listCampaignOptimizationRules } from "./adapters/sp-rules.js";
import {
  createAdGroups,
  createCampaigns,
  createKeywords,
  createNegativeKeywords,
  createCampaignNegativeKeywords,
  createNegativeTargets,
  createProductAds,
  createTargets,
  deleteCampaignNegativeKeywords,
  deleteNegativeKeywords,
  disableOptimizationRules,
  updateAdGroupDefaultBids,
  updateCampaignBidding,
  updateCampaigns,
  updateKeywordBids,
  updateTargetBids,
  type ResolvedCreateAdGroupAction,
  type ResolvedCreateKeywordAction,
  type ResolvedCreateProductAdAction,
  type ResolvedCreateTargetAction,
} from "./adapters/sp-writes.js";
import type {
  ActionResult,
  AmazonRegion,
  CampaignBidControls,
  Capabilities,
  ChangeSet,
  Profile,
  ReportJob,
  ReportSpec,
  ReportStatus,
  SpReportTypeId,
  StructureSnapshot,
} from "./types.js";

/**
 * Internal Amazon gateway (plan §6). The optimizer and API layers only see
 * this interface and the internal domain models; raw Amazon payloads are
 * validated and translated inside the adapters.
 */
export interface AmazonAdsGateway {
  listProfiles(connectionId: string): Promise<Profile[]>;
  syncCampaignStructure(profileId: string): Promise<StructureSnapshot>;
  getCampaignBidControls(
    profileId: string,
    campaignId: string,
  ): Promise<CampaignBidControls>;
  requestReport(profileId: string, spec: ReportSpec): Promise<ReportJob>;
  getReport(reportId: string): Promise<ReportStatus>;
  previewCapabilities(profileId: string): Promise<Capabilities>;
  applyActions(changeSet: ChangeSet): Promise<ActionResult[]>;
}

/** Stored profile/account metadata owned by the DB layer; the gateway reads it to derive headers. */
export interface ProfileDirectoryEntry {
  profileId: string;
  connectionId: string;
  region: AmazonRegion;
  accountId: string | null;
}

export interface GatewayOptions {
  /** LWA client id — goes into Amazon-Advertising-API-ClientId headers. */
  clientId: string;
  tokenManager: Pick<TokenManager, "getAccessToken">;
  /** Look up stored profile metadata by internal profileId. */
  profileDirectory: {
    get(profileId: string): Promise<ProfileDirectoryEntry>;
  };
  /** Optional resolver mapping an Amazon reportId back to its profile (e.g. after worker restart). */
  reportOwner?: (reportId: string) => Promise<string | null>;
  http?: AdsHttpClient;
  logger?: LoggerLike;
  now?: () => string;
}

const SUPPORTED_REPORT_TYPES: SpReportTypeId[] = [
  "spCampaigns",
  "spSearchTerm",
  "spTargeting",
  "spAdvertisedProduct",
];

export function createAmazonAdsGateway(
  options: GatewayOptions,
): AmazonAdsGateway {
  const http =
    options.http ?? createAdsHttpClient({ clientId: options.clientId });
  const logger = options.logger ?? defaultLogger();
  const now = options.now ?? (() => new Date().toISOString());
  /** In-memory reportId → profileId map for reports requested through this instance. */
  const reportOwners = new Map<string, string>();

  async function contextFor(
    profileId: string,
  ): Promise<AdsRequestContext & { profileId: string }> {
    const entry = await options.profileDirectory.get(profileId);
    const accessToken = await options.tokenManager.getAccessToken(
      entry.connectionId,
    );
    return {
      region: entry.region,
      accessToken,
      profileId: entry.profileId,
      accountId: entry.accountId,
    };
  }

  return {
    async listProfiles(connectionId: string): Promise<Profile[]> {
      const accessToken =
        await options.tokenManager.getAccessToken(connectionId);
      // Profiles can exist in any region; discover across all hosts (plan §5 step 5).
      return listAllProfiles(http, accessToken);
    },

    async syncCampaignStructure(profileId: string): Promise<StructureSnapshot> {
      const context = await contextFor(profileId);
      const [
        campaigns,
        adGroups,
        ads,
        keywords,
        targets,
        negativeKeywords,
        negativeTargets,
      ] = await Promise.all([
        listCampaigns(http, context),
        listAdGroups(http, context),
        listProductAds(http, context),
        listKeywords(http, context),
        listTargets(http, context),
        listNegativeKeywords(http, context),
        listNegativeTargets(http, context),
      ]);
      logger.info(
        {
          profileId,
          campaigns: campaigns.length,
          adGroups: adGroups.length,
          ads: ads.length,
          keywords: keywords.length,
          targets: targets.length,
          negativeKeywords: negativeKeywords.length,
          negativeTargets: negativeTargets.length,
        },
        "Campaign structure snapshot retrieved",
      );
      return {
        profileId,
        retrievedAt: now(),
        campaigns,
        adGroups,
        ads,
        keywords,
        targets,
        negativeKeywords,
        negativeTargets,
      };
    },

    async getCampaignBidControls(
      profileId: string,
      campaignId: string,
    ): Promise<CampaignBidControls> {
      const context = await contextFor(profileId);
      const [campaigns, adGroups, keywords, targets, optimizationRules] =
        await Promise.all([
          listCampaigns(http, context),
          listAdGroups(http, context),
          listKeywords(http, context),
          listTargets(http, context),
          listCampaignOptimizationRules(http, context, campaignId),
        ]);
      const campaign = campaigns.find((item) => item.campaignId === campaignId);
      if (!campaign) {
        throw new Error(`Amazon campaign ${campaignId} was not found`);
      }
      return {
        profileId,
        retrievedAt: now(),
        campaign,
        adGroups: adGroups.filter((item) => item.campaignId === campaignId),
        keywords: keywords.filter((item) => item.campaignId === campaignId),
        targets: targets.filter((item) => item.campaignId === campaignId),
        optimizationRules,
      };
    },

    async requestReport(
      profileId: string,
      spec: ReportSpec,
    ): Promise<ReportJob> {
      const context = await contextFor(profileId);
      const job = await requestReport(http, context, spec, now);
      reportOwners.set(job.reportId, profileId);
      return job;
    },

    async getReport(reportId: string): Promise<ReportStatus> {
      const profileId =
        reportOwners.get(reportId) ??
        (options.reportOwner ? await options.reportOwner(reportId) : null);
      if (!profileId) {
        throw new Error(
          `Unknown reportId ${reportId}: no owning profile on record`,
        );
      }
      const context = await contextFor(profileId);
      return getReportStatus(http, context, reportId);
    },

    async previewCapabilities(profileId: string): Promise<Capabilities> {
      const entry = await options.profileDirectory.get(profileId);
      return {
        profileId: entry.profileId,
        region: entry.region,
        adProducts: ["SPONSORED_PRODUCTS"],
        reportTypes: SUPPORTED_REPORT_TYPES,
        writeOperations: [
          "create_campaign",
          "create_ad_group",
          "create_product_ad",
          "create_keyword",
          "create_target",
          "update_bid",
          "update_ad_group_default_bid",
          "update_campaign_bidding",
          "update_campaign_state",
          "update_campaign_name",
          "update_optimization_rule",
          "add_negative_exact",
          "remove_negative_exact",
          "add_negative_target",
        ],
      };
    },

    async applyActions(changeSet: ChangeSet): Promise<ActionResult[]> {
      const context = await contextFor(changeSet.profileId);
      const bidActions = changeSet.actions.filter(
        (action) => action.kind === "update_bid",
      );
      const keywordBidActions = bidActions.filter(
        (action) => action.entityType !== "target",
      );
      const targetBidActions = bidActions.filter(
        (action) => action.entityType === "target",
      );
      const adGroupActions = changeSet.actions.filter(
        (action) => action.kind === "update_ad_group_default_bid",
      );
      const campaignActions = changeSet.actions.filter(
        (action) => action.kind === "update_campaign_bidding",
      );
      const campaignStateActions = changeSet.actions.filter(
        (action) => action.kind === "update_campaign_state",
      );
      const campaignNameActions = changeSet.actions.filter(
        (action) => action.kind === "update_campaign_name",
      );
      const ruleActions = changeSet.actions.filter(
        (action) => action.kind === "update_optimization_rule",
      );
      const negativeActions = changeSet.actions.filter(
        (action) => action.kind === "add_negative_exact",
      );
      const adGroupNegativeActions = negativeActions.filter(
        (action) => action.adGroupId !== undefined,
      );
      const campaignNegativeActions = negativeActions.filter(
        (action) => action.adGroupId === undefined,
      );
      const negativeTargetActions = changeSet.actions.filter(
        (action) => action.kind === "add_negative_target",
      );
      const negativeRemovalActions = changeSet.actions.filter(
        (action) => action.kind === "remove_negative_exact",
      );
      const adGroupNegativeRemovalActions = negativeRemovalActions.filter(
        (action) => action.scope === "ad_group",
      );
      const campaignNegativeRemovalActions = negativeRemovalActions.filter(
        (action) => action.scope === "campaign",
      );
      const createCampaignActions = changeSet.actions.filter(
        (action) => action.kind === "create_campaign",
      );
      const createAdGroupActions = changeSet.actions.filter(
        (action) => action.kind === "create_ad_group",
      );
      const createProductAdActions = changeSet.actions.filter(
        (action) => action.kind === "create_product_ad",
      );
      const createKeywordActions = changeSet.actions.filter(
        (action) => action.kind === "create_keyword",
      );
      const createTargetActions = changeSet.actions.filter(
        (action) => action.kind === "create_target",
      );
      const results: ActionResult[] = [];
      const parentFailed = (action: { actionId: string }): ActionResult => ({
        actionId: action.actionId,
        status: "failed",
        code: "PARENT_FAILED",
        message: "Parent entity was not created in this change set",
      });
      // Creation phases run before updates, in dependency order. Children
      // reference their parent by the parent's actionId; the Amazon id is
      // only known after the parent phase completes.
      const campaignIdsByActionId = new Map<string, string>();
      if (createCampaignActions.length > 0) {
        const campaignResults = await createCampaigns(
          http,
          context,
          createCampaignActions,
        );
        for (const result of campaignResults) {
          if (result.status === "applied" && result.amazonEntityId) {
            campaignIdsByActionId.set(result.actionId, result.amazonEntityId);
          }
        }
        results.push(...campaignResults);
      }
      const adGroupsByActionId = new Map<
        string,
        { adGroupId: string; campaignId: string }
      >();
      // Pre-resolved parent ids (partial retry: the ad group already exists
      // on Amazon) win over in-call phase resolution.
      const adGroupParent = (action: {
        adGroupActionId: string;
        resolvedCampaignId?: string;
        resolvedAdGroupId?: string;
      }): { adGroupId: string; campaignId: string } | undefined =>
        action.resolvedAdGroupId && action.resolvedCampaignId
          ? {
              adGroupId: action.resolvedAdGroupId,
              campaignId: action.resolvedCampaignId,
            }
          : adGroupsByActionId.get(action.adGroupActionId);
      if (createAdGroupActions.length > 0) {
        const resolved: ResolvedCreateAdGroupAction[] = [];
        for (const action of createAdGroupActions) {
          // A pre-resolved parent id (partial retry: the campaign already
          // exists on Amazon) wins over in-call phase resolution.
          const campaignId =
            action.resolvedCampaignId ??
            campaignIdsByActionId.get(action.campaignActionId);
          if (campaignId) {
            resolved.push({ ...action, resolvedCampaignId: campaignId });
          } else {
            results.push(parentFailed(action));
          }
        }
        if (resolved.length > 0) {
          const adGroupResults = await createAdGroups(http, context, resolved);
          for (const result of adGroupResults) {
            const parent = resolved.find(
              (action) => action.actionId === result.actionId,
            );
            if (
              result.status === "applied" &&
              result.amazonEntityId &&
              parent
            ) {
              adGroupsByActionId.set(result.actionId, {
                adGroupId: result.amazonEntityId,
                campaignId: parent.resolvedCampaignId,
              });
            }
          }
          results.push(...adGroupResults);
        }
      }
      if (createProductAdActions.length > 0) {
        const resolved: ResolvedCreateProductAdAction[] = [];
        for (const action of createProductAdActions) {
          // The product ad also needs campaignId; derive it from the
          // resolved ad group's parent campaign.
          const parent = adGroupParent(action);
          if (parent) {
            resolved.push({
              ...action,
              resolvedCampaignId: parent.campaignId,
              resolvedAdGroupId: parent.adGroupId,
            });
          } else {
            results.push(parentFailed(action));
          }
        }
        if (resolved.length > 0) {
          results.push(...(await createProductAds(http, context, resolved)));
        }
      }
      if (createKeywordActions.length > 0) {
        const resolved: ResolvedCreateKeywordAction[] = [];
        for (const action of createKeywordActions) {
          const parent = adGroupParent(action);
          if (parent) {
            resolved.push({
              ...action,
              resolvedCampaignId: parent.campaignId,
              resolvedAdGroupId: parent.adGroupId,
            });
          } else {
            results.push(parentFailed(action));
          }
        }
        if (resolved.length > 0) {
          results.push(...(await createKeywords(http, context, resolved)));
        }
      }
      if (createTargetActions.length > 0) {
        const resolved: ResolvedCreateTargetAction[] = [];
        for (const action of createTargetActions) {
          const parent = adGroupParent(action);
          if (parent) {
            resolved.push({
              ...action,
              resolvedCampaignId: parent.campaignId,
              resolvedAdGroupId: parent.adGroupId,
            });
          } else {
            results.push(parentFailed(action));
          }
        }
        if (resolved.length > 0) {
          results.push(...(await createTargets(http, context, resolved)));
        }
      }
      if (keywordBidActions.length > 0) {
        results.push(
          ...(await updateKeywordBids(http, context, keywordBidActions)),
        );
      }
      if (targetBidActions.length > 0) {
        results.push(
          ...(await updateTargetBids(http, context, targetBidActions)),
        );
      }
      if (adGroupActions.length > 0) {
        results.push(
          ...(await updateAdGroupDefaultBids(http, context, adGroupActions)),
        );
      }
      if (campaignActions.length > 0) {
        results.push(
          ...(await updateCampaignBidding(http, context, campaignActions)),
        );
      }
      // State and name updates go in separate batches: one request must not
      // carry two items for the same campaignId.
      if (campaignStateActions.length > 0) {
        results.push(
          ...(await updateCampaigns(http, context, campaignStateActions)),
        );
      }
      if (campaignNameActions.length > 0) {
        results.push(
          ...(await updateCampaigns(http, context, campaignNameActions)),
        );
      }
      if (ruleActions.length > 0) {
        results.push(
          ...(await disableOptimizationRules(http, context, ruleActions)),
        );
      }
      if (adGroupNegativeActions.length > 0) {
        results.push(
          ...(await createNegativeKeywords(
            http,
            context,
            adGroupNegativeActions,
          )),
        );
      }
      if (campaignNegativeActions.length > 0) {
        results.push(
          ...(await createCampaignNegativeKeywords(
            http,
            context,
            campaignNegativeActions,
          )),
        );
      }
      if (negativeTargetActions.length > 0) {
        results.push(
          ...(await createNegativeTargets(
            http,
            context,
            negativeTargetActions,
          )),
        );
      }
      if (adGroupNegativeRemovalActions.length > 0) {
        results.push(
          ...(await deleteNegativeKeywords(
            http,
            context,
            adGroupNegativeRemovalActions,
          )),
        );
      }
      if (campaignNegativeRemovalActions.length > 0) {
        results.push(
          ...(await deleteCampaignNegativeKeywords(
            http,
            context,
            campaignNegativeRemovalActions,
          )),
        );
      }
      logger.info(
        {
          changeSetId: changeSet.changeSetId,
          profileId: changeSet.profileId,
          applied: results.filter((r) => r.status === "applied").length,
          failed: results.filter((r) => r.status === "failed").length,
        },
        "Change set applied",
      );
      return results;
    },
  };
}
