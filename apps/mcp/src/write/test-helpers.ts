import type { Pool } from "@amazon-king/database";

export interface MockTables {
  workspaceMembers: Array<{
    workspace_id: string;
    user_id: string;
    role: string;
  }>;
  amazonConnections: Array<{ id: string; workspace_id: string }>;
  amazonProfiles: Array<{
    id: string;
    connection_id: string;
    enabled: boolean;
    profile_id?: string;
    country_code?: string;
    currency_code?: string;
  }>;
  campaigns: Array<{
    id: string;
    profile_id: string;
    amazon_campaign_id: string;
    name: string;
    state: string;
    raw_json?: {
      dynamicBidding?: {
        strategy?: string;
        placements?: Array<{ name: string; percentage: number }>;
        audiences?: unknown[];
      };
    };
  }>;
  adGroups: Array<{
    id: string;
    campaign_id: string;
    amazon_ad_group_id: string;
    name: string;
    default_bid: string;
  }>;
  targets: Array<{
    id: string;
    campaign_id: string;
    amazon_target_id: string;
    target_kind: string;
    bid: string;
  }>;
  recommendations: Array<{
    id: string;
    profile_id: string;
    type: string;
    state: string;
    expires_at: string;
    campaign_id: string | null;
    ad_group_id: string | null;
    target_id: string | null;
    search_term: string | null;
    current_value: string | null;
    proposed_value: string | null;
  }>;
  searchTermMetricsDaily: Array<{
    profile_id: string;
    campaign_id: string;
    search_term: string;
    metric_date: string;
    clicks: number;
  }>;
  negativeKeywords: Array<{
    id: string;
    campaign_id: string;
    keyword_text: string;
    state: string;
  }>;
  negativeTargets: Array<{
    id: string;
    campaign_id: string;
    expression_asin: string;
    state: string;
  }>;
  changeSets: any[];
  changeActions: any[];
  auditEvents: any[];
  recommendationDismissals: any[];
  searchTermExclusions: any[];
  bidPolicies: any[];
}

export function setupMockPool(overrides?: Partial<MockTables>) {
  const tables: MockTables = {
    workspaceMembers: [
      { workspace_id: "ws-1", user_id: "user-owner-1", role: "owner" },
    ],
    amazonConnections: [{ id: "conn-1", workspace_id: "ws-1" }],
    amazonProfiles: [
      {
        id: "prof-1",
        connection_id: "conn-1",
        enabled: true,
        profile_id: "amz-prof-1",
        country_code: "US",
        currency_code: "USD",
      },
    ],
    campaigns: [
      {
        id: "camp-1",
        profile_id: "prof-1",
        amazon_campaign_id: "amz-camp-1",
        name: "Space Novel Promo",
        state: "enabled",
        raw_json: {
          dynamicBidding: {
            strategy: "LEGACY_FOR_SALES",
            placements: [
              { name: "PLACEMENT_TOP", percentage: 25 },
              { name: "PLACEMENT_PRODUCT_PAGE", percentage: 0 },
            ],
            audiences: [],
          },
        },
      },
    ],
    adGroups: [
      {
        id: "ag-1",
        campaign_id: "camp-1",
        amazon_ad_group_id: "amz-ag-1",
        name: "Main AdGroup",
        default_bid: "0.5500",
      },
    ],
    targets: [
      {
        id: "tgt-1",
        campaign_id: "camp-1",
        amazon_target_id: "amz-tgt-1",
        target_kind: "target",
        bid: "0.7500",
      },
      {
        id: "tgt-2",
        campaign_id: "camp-1",
        amazon_target_id: "amz-tgt-2",
        target_kind: "keyword",
        bid: "0.2000",
      },
    ],
    recommendations: [
      {
        id: "rec-1",
        profile_id: "prof-1",
        type: "expensive_target",
        state: "pending",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        campaign_id: "camp-1",
        ad_group_id: "ag-1",
        target_id: "tgt-1",
        search_term: null,
        current_value: "0.7500",
        proposed_value: "0.4500",
      },
    ],
    searchTermMetricsDaily: [
      {
        profile_id: "prof-1",
        campaign_id: "amz-camp-1",
        search_term: "sci-fi books",
        metric_date: new Date().toISOString().slice(0, 10),
        clicks: 5,
      },
    ],
    negativeKeywords: [],
    negativeTargets: [],
    changeSets: [],
    changeActions: [],
    auditEvents: [],
    recommendationDismissals: [],
    searchTermExclusions: [],
    bidPolicies: [],
    ...overrides,
  };

  let nextId = 100;

  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const lower = sql.toLowerCase().replace(/\s+/g, " ");

      if (lower === "begin" || lower === "commit" || lower === "rollback") {
        return { rows: [], rowCount: 0 };
      }

      if (lower.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }

      // workspace_members query
      if (lower.includes("from workspace_members")) {
        const wsId = params[0];
        const match = tables.workspaceMembers.filter(
          (m) => m.workspace_id === wsId && m.role === "owner",
        );
        return { rows: match, rowCount: match.length };
      }

      // campaigns query
      if (
        lower.includes("from campaigns c") &&
        lower.includes("join amazon_profiles")
      ) {
        const wsId = params[0];
        const cId = String(params[1]);
        const match = tables.campaigns.filter(
          (c) => c.id === cId || c.amazon_campaign_id === cId,
        );
        return { rows: match, rowCount: match.length };
      }

      // structure.getCampaign query
      if (lower.includes("from campaigns") && lower.includes("where id = $1")) {
        const id = String(params[0]);
        const match = tables.campaigns.filter((c) => c.id === id);
        return { rows: match, rowCount: match.length };
      }

      // ad_groups query
      if (lower.includes("from ad_groups where campaign_id = $1")) {
        const cId = String(params[0]);
        let match = tables.adGroups.filter((ag) => ag.campaign_id === cId);
        if (params[1]) {
          const targetAgId = String(params[1]);
          match = match.filter(
            (ag) =>
              ag.id === targetAgId || ag.amazon_ad_group_id === targetAgId,
          );
        }
        return { rows: match, rowCount: match.length };
      }

      // targets query
      if (lower.includes("from targets where campaign_id = $1")) {
        const cId = String(params[0]);
        const match = tables.targets.filter((t) => t.campaign_id === cId);
        return { rows: match, rowCount: match.length };
      }

      // recommendations query
      if (lower.includes("from recommendations r")) {
        if (lower.includes("r.id = any($2::bigint[])")) {
          const ids = (params[1] as string[]).map(String);
          const match = tables.recommendations.filter((r) =>
            ids.includes(r.id),
          );
          return { rows: match, rowCount: match.length };
        }
        if (lower.includes("r.id = $2")) {
          const id = String(params[1]);
          const match = tables.recommendations.filter((r) => r.id === id);
          return { rows: match, rowCount: match.length };
        }
      }

      // transitionRecommendationState
      if (lower.includes("update recommendations set state = $3")) {
        const id = String(params[0]);
        const fromState = params[1];
        const toState = params[2];
        const rec = tables.recommendations.find(
          (r) => r.id === id && r.state === fromState,
        );
        if (rec) {
          rec.state = toState as string;
          return {
            rows: [
              {
                id: rec.id,
                profile_id: rec.profile_id,
                type: rec.type,
                campaign_id: rec.campaign_id,
                ad_group_id: rec.ad_group_id,
                target_id: rec.target_id,
                search_term: rec.search_term,
                priority: 1,
                evidence_window_start: "2026-08-01",
                evidence_window_end: "2026-08-15",
                current_value: rec.current_value,
                proposed_value: rec.proposed_value,
                rationale: "test",
                confidence: "0.8",
                state: rec.state,
                rule_version: "v1",
                data_freshness_at: new Date(),
                expires_at: rec.expires_at,
                created_at: new Date(),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // search_term_metrics_daily clicks check
      if (
        lower.includes(
          "from search_term_metrics_daily where profile_id = $1 and campaign_id = $2",
        )
      ) {
        const match = tables.searchTermMetricsDaily.filter(
          (m) =>
            m.profile_id === params[0] &&
            m.campaign_id === params[1] &&
            m.clicks > 0,
        );
        return {
          rows: match.map((m) => ({ term: m.search_term })),
          rowCount: match.length,
        };
      }

      // listSearchTermServingCampaigns
      if (
        lower.includes(
          "from search_term_metrics_daily m join campaigns c on c.profile_id = m.profile_id",
        )
      ) {
        const term = String(params[3]);
        const match = tables.searchTermMetricsDaily.filter(
          (m) => m.search_term.toLowerCase() === term.toLowerCase(),
        );
        return {
          rows: match.map((m) => ({
            profile_pk: m.profile_id,
            campaign_pk: "camp-1",
          })),
          rowCount: match.length,
        };
      }

      // profiles.listProfilesByWorkspace
      if (lower.includes("from amazon_profiles p join amazon_connections")) {
        return {
          rows: tables.amazonProfiles,
          rowCount: tables.amazonProfiles.length,
        };
      }

      // structure.listCampaignsByProfile
      if (lower.includes("from campaigns where profile_id = $1")) {
        return { rows: tables.campaigns, rowCount: tables.campaigns.length };
      }

      // structure.listNegativeKeywordsByProfile
      if (lower.includes("from negative_keywords where profile_id = $1")) {
        return {
          rows: tables.negativeKeywords,
          rowCount: tables.negativeKeywords.length,
        };
      }

      // structure.listNegativeTargetsByProfile
      if (lower.includes("from negative_targets where profile_id = $1")) {
        return {
          rows: tables.negativeTargets,
          rowCount: tables.negativeTargets.length,
        };
      }

      // exclusions.addExclusion
      if (lower.includes("insert into search_term_exclusions")) {
        const row = {
          id: String(++nextId),
          workspace_id: params[0],
          search_term: params[1],
          created_at: new Date().toISOString(),
        };
        tables.searchTermExclusions.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // changes.findChangeSetByFingerprint
      if (lower.includes("from change_sets where fingerprint = $1")) {
        const fp = params[0];
        const match = tables.changeSets.filter((cs) => cs.fingerprint === fp);
        return { rows: match, rowCount: match.length };
      }

      // changes.listActionsByChangeSet
      if (lower.includes("from change_actions where change_set_id = $1")) {
        const csId = params[0];
        const match = tables.changeActions.filter(
          (ca) => ca.change_set_id === csId,
        );
        return { rows: match, rowCount: match.length };
      }

      // changes.createChangeSet
      if (lower.includes("insert into change_sets")) {
        const row = {
          id: String(++nextId),
          profile_id: params[0],
          creator_user_id: params[1],
          fingerprint: params[2],
          guardrail_result: params[3],
          kind: params[4],
          status: "draft",
          metadata:
            typeof params[5] === "string"
              ? JSON.parse(params[5])
              : (params[5] ?? {}),
          created_at: new Date().toISOString(),
        };
        tables.changeSets.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // changes.createChangeActions
      if (lower.includes("insert into change_actions")) {
        const rows = [
          {
            id: String(++nextId),
            change_set_id: "101",
            action_type: "update_bid",
            status: "pending",
            campaign_id: "camp-1",
          },
        ];
        tables.changeActions.push(...rows);
        return { rows, rowCount: rows.length };
      }

      // audit.insertAuditEvent
      if (lower.includes("insert into audit_events")) {
        const row = {
          id: String(++nextId),
          workspace_id: params[0],
          actor_user_id: params[1],
          event: params[2],
          entity_type: params[3],
          entity_id: params[4],
          details:
            typeof params[7] === "string"
              ? JSON.parse(params[7])
              : (params[7] ?? {}),
          created_at: new Date().toISOString(),
        };
        tables.auditEvents.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // recommendations.upsertRecommendationDismissal
      if (lower.includes("insert into recommendation_dismissals")) {
        const row = {
          id: String(++nextId),
          profile_id: params[0],
          type: params[1],
          campaign_id: params[2],
          ad_group_id: params[3],
          target_id: params[4],
          search_term: params[5],
          recommendation_id: params[6],
          dismissed_until: params[7],
        };
        tables.recommendationDismissals.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // bidPolicies.upsertPendingCampaignBidPolicy
      if (lower.includes("insert into campaign_bid_policies")) {
        const row = {
          id: String(++nextId),
          campaign_id: params[0],
          max_cpc: params[1],
          status: "pending",
          change_set_id: params[2],
        };
        tables.bidPolicies.push(row);
        return { rows: [row], rowCount: 1 };
      }

      throw new Error(`Unhandled SQL in test: ${sql}`);
    },
    async connect() {
      return {
        query: pool.query.bind(pool),
        release: () => {},
      };
    },
  };

  return { pool: pool as unknown as Pool, tables };
}
