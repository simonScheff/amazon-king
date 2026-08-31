/* In-memory fake of the Postgres `Db`/`Pool` surface used by the services.
 * It pattern-matches the exact SQL of the repository functions the tested
 * code paths hit and emulates their semantics (single-use consumes, guarded
 * transitions, coalesce updates). Unknown statements throw so tests fail
 * loudly when a service starts touching something new.
 */

export interface FakeRow {
  [key: string]: unknown;
}

export interface FakeTables {
  users: FakeRow[];
  workspaces: FakeRow[];
  workspaceMembers: FakeRow[];
  sessions: FakeRow[];
  loginTokens: FakeRow[];
  oauthStates: FakeRow[];
  amazonConnections: FakeRow[];
  amazonProfiles: FakeRow[];
  campaigns: FakeRow[];
  adGroups: FakeRow[];
  targets: FakeRow[];
  recommendations: FakeRow[];
  recommendationEvidence: FakeRow[];
  recommendationDismissals: FakeRow[];
  changeSets: FakeRow[];
  changeActions: FakeRow[];
  campaignBidPolicies: FakeRow[];
  syncRuns: FakeRow[];
  reportJobs: FakeRow[];
  jobQueue: FakeRow[];
  auditEvents: FakeRow[];
  ads: FakeRow[];
  books: FakeRow[];
  bookProfileLinks: FakeRow[];
  bookEconomics: FakeRow[];
  searchTermMetricsDaily: FakeRow[];
  campaignMetricsDaily: FakeRow[];
  advertisedProductMetricsDaily: FakeRow[];
  negativeKeywords: FakeRow[];
  negativeTargets: FakeRow[];
  searchTermExclusions: FakeRow[];
  fxRates: FakeRow[];
  kdpRoyaltyImports: FakeRow[];
  kdpSaleTransactions: FakeRow[];
}

function emptyTables(): FakeTables {
  return {
    users: [],
    workspaces: [],
    workspaceMembers: [],
    sessions: [],
    loginTokens: [],
    oauthStates: [],
    amazonConnections: [],
    amazonProfiles: [],
    campaigns: [],
    adGroups: [],
    targets: [],
    recommendations: [],
    recommendationEvidence: [],
    recommendationDismissals: [],
    changeSets: [],
    changeActions: [],
    campaignBidPolicies: [],
    syncRuns: [],
    reportJobs: [],
    jobQueue: [],
    auditEvents: [],
    ads: [],
    books: [],
    bookProfileLinks: [],
    bookEconomics: [],
    searchTermMetricsDaily: [],
    campaignMetricsDaily: [],
    advertisedProductMetricsDaily: [],
    negativeKeywords: [],
    negativeTargets: [],
    searchTermExclusions: [],
    fxRates: [],
    kdpRoyaltyImports: [],
    kdpSaleTransactions: [],
  };
}

interface QueryResult {
  rows: FakeRow[];
  rowCount: number;
}

interface Handler {
  match: string;
  handle: (params: unknown[], db: FakeDb, text: string) => QueryResult;
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Normalize a date column value (pg may hand back Date objects) to YYYY-MM-DD. */
function dateOnly(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

let idCounter = 1000;
function nextId(): string {
  return String(++idCounter);
}

export class FakeDb {
  readonly tables: FakeTables = emptyTables();
  /** Statements that had no registered handler (for debugging). */
  readonly misses: string[] = [];

  private ok(rows: FakeRow[] = []): QueryResult {
    return { rows, rowCount: rows.length };
  }

  // -- seed helpers ---------------------------------------------------------

  seedWorkspace(id = "1"): void {
    this.tables.workspaces.push({ id, name: "test", created_at: new Date() });
  }

  seedUser(email: string, id = "1", workspaceId = "1"): void {
    this.tables.users.push({ id, email, created_at: new Date() });
    this.tables.workspaceMembers.push({
      workspace_id: workspaceId,
      user_id: id,
      role: "owner",
    });
  }

  seedConnection(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      workspace_id: "1",
      encrypted_refresh_token: Buffer.from("ciphertext"),
      encryption_key_version: 1,
      status: "connected",
      granted_at: new Date(),
      revoked_at: null,
      last_error_code: null,
      created_at: new Date(),
      ...overrides,
    };
    this.tables.amazonConnections.push(row);
    return row;
  }

  seedProfile(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      connection_id: "1",
      profile_id: "amz-profile-1",
      account_id: null,
      region: "NA",
      country_code: "US",
      currency_code: "USD",
      timezone: null,
      account_type: null,
      enabled: true,
      write_enabled: false,
      ...overrides,
    };
    this.tables.amazonProfiles.push(row);
    return row;
  }

  seedRecommendation(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      profile_id: "1",
      type: "expensive_target",
      campaign_id: "10",
      ad_group_id: "20",
      target_id: "30",
      search_term: null,
      priority: 2,
      evidence_window_start: "2026-07-01",
      evidence_window_end: "2026-07-31",
      current_value: "0.5000",
      proposed_value: "0.5500",
      rationale: "test",
      confidence: "0.800",
      state: "pending",
      rule_version: "v1",
      data_freshness_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
      created_at: new Date(),
      ...overrides,
    };
    this.tables.recommendations.push(row);
    return row;
  }

  seedRecommendationEvidence(
    recommendationId: string,
    inputs: unknown,
  ): FakeRow {
    const row = {
      id: nextId(),
      recommendation_id: recommendationId,
      inputs,
      created_at: new Date(),
    };
    this.tables.recommendationEvidence.push(row);
    return row;
  }

  seedChangeSet(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      profile_id: "1",
      creator_user_id: "1",
      status: "draft",
      guardrail_result: null,
      fingerprint: `fp-${nextId()}`,
      created_at: new Date(),
      applied_at: null,
      kind: "recommendation",
      metadata: {},
      ...overrides,
    };
    this.tables.changeSets.push(row);
    return row;
  }

  seedChangeAction(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      change_set_id: "1",
      recommendation_id: null,
      action_type: "update_bid",
      campaign_id: "10",
      ad_group_id: "20",
      target_id: "30",
      search_term: null,
      before_value: "0.5000",
      after_value: "0.5500",
      fingerprint: `afp-${nextId()}`,
      status: "pending",
      amazon_request: null,
      amazon_response: null,
      amazon_request_id: null,
      verified_at: null,
      rollback_of_id: null,
      amazon_entity_id: null,
      entity_name: null,
      before_state: null,
      after_state: null,
      created_at: new Date(),
      ...overrides,
    };
    this.tables.changeActions.push(row);
    return row;
  }

  seedTarget(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: "30",
      profile_id: "1",
      campaign_id: "10",
      ad_group_id: "20",
      amazon_target_id: "kw-1",
      target_kind: "keyword",
      bid: "0.5000",
      state: "enabled",
      ...overrides,
    };
    this.tables.targets.push(row);
    return row;
  }

  seedCampaign(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: "10",
      profile_id: "1",
      amazon_campaign_id: "camp-1",
      name: "Campaign",
      state: "enabled",
      targeting_type: "manual",
      ...overrides,
    };
    this.tables.campaigns.push(row);
    return row;
  }

  seedAdGroup(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: "20",
      profile_id: "1",
      campaign_id: "10",
      amazon_ad_group_id: "ag-1",
      name: "Ad group",
      state: "enabled",
      default_bid: "0.5000",
      ...overrides,
    };
    this.tables.adGroups.push(row);
    return row;
  }

  seedAd(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      profile_id: "1",
      ad_group_id: "20",
      amazon_ad_id: "ad-1",
      asin: "B012345678",
      state: "enabled",
      ...overrides,
    };
    this.tables.ads.push(row);
    return row;
  }

  seedSearchTermMetric(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      profile_id: "1",
      campaign_id: "camp-1",
      ad_group_id: "ag-1",
      search_term: "term",
      metric_date: "2026-07-01",
      impressions: 100,
      clicks: 10,
      cost: "5.0000",
      sales: "0.0000",
      orders: 0,
      units: 0,
      currency: "USD",
      ...overrides,
    };
    this.tables.searchTermMetricsDaily.push(row);
    return row;
  }

  seedNegativeKeyword(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      profile_id: "1",
      campaign_id: "10",
      ad_group_id: null,
      amazon_negative_keyword_id: `negative-${nextId()}`,
      keyword_text: "blocked term",
      match_type: "NEGATIVE_EXACT",
      state: "enabled",
      ...overrides,
    };
    this.tables.negativeKeywords.push(row);
    return row;
  }

  seedNegativeTarget(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      profile_id: "1",
      campaign_id: "10",
      ad_group_id: null,
      amazon_negative_target_id: `negative-target-${nextId()}`,
      expression_asin: "B0BLOCKED1",
      state: "enabled",
      ...overrides,
    };
    this.tables.negativeTargets.push(row);
    return row;
  }

  seedExclusion(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      workspace_id: "1",
      search_term: "excluded term",
      created_at: new Date(),
      ...overrides,
    };
    this.tables.searchTermExclusions.push(row);
    return row;
  }

  seedBook(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      workspace_id: "1",
      asin: "B012345678",
      title: "Book",
      format: "paperback",
      status: "active",
      cover_json: null,
      created_at: new Date(),
      ...overrides,
    };
    this.tables.books.push(row);
    return row;
  }

  seedBookProfileLink(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      book_id: "1",
      profile_id: "1",
      marketplace_asin: "B012345678",
      enabled: true,
      ...overrides,
    };
    this.tables.bookProfileLinks.push(row);
    return row;
  }

  seedBookEconomics(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      book_id: "1",
      profile_id: "1",
      effective_from: "2026-01-01",
      currency: "USD",
      list_price: "12.0000",
      estimated_royalty_per_sale: "7.0000",
      target_acos: null,
      goal_mode: "balanced",
      ...overrides,
    };
    this.tables.bookEconomics.push(row);
    return row;
  }

  seedFxRate(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      rate_date: "2026-08-14",
      base_currency: "USD",
      quote_currency: "EUR",
      rate: "0.8000",
      source: "frankfurter",
      fetched_at: new Date(),
      ...overrides,
    };
    this.tables.fxRates.push(row);
    return row;
  }

  seedKdpRoyaltyImport(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      workspace_id: "1",
      file_name: "kdp.xlsx",
      payload_sha256: `hash-${nextId()}`,
      period_start: "2026-08-01",
      period_end: "2026-08-25",
      row_count: 0,
      suggestions: [],
      skipped: [],
      rows: [],
      created_at: new Date(),
      applied_at: null,
      ...overrides,
    };
    this.tables.kdpRoyaltyImports.push(row);
    return row;
  }

  seedKdpSaleTransaction(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      id: nextId(),
      workspace_id: "1",
      import_id: "1",
      book_id: "1",
      profile_id: "1",
      asin: "B012345678",
      marketplace: "Amazon.com",
      format: "paperback",
      royalty_type: "60%",
      transaction_type: "Standard - Paperback",
      order_date: "2026-08-20",
      royalty_date: "2026-08-23",
      net_units: 1,
      royalty: "3.43",
      currency: "USD",
      ...overrides,
    };
    this.tables.kdpSaleTransactions.push(row);
    return row;
  }

  seedCampaignMetric(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      profile_id: "1",
      campaign_id: "camp-1",
      metric_date: "2026-08-14",
      impressions: 10,
      clicks: 1,
      cost: "5.0000",
      sales: "0.0000",
      orders: 0,
      units: 0,
      currency: "USD",
      ...overrides,
    };
    this.tables.campaignMetricsDaily.push(row);
    return row;
  }

  seedAdvertisedProductMetric(overrides: Partial<FakeRow> = {}): FakeRow {
    const row = {
      profile_id: "1",
      campaign_id: "camp-1",
      ad_group_id: "ag-1",
      ad_id: "ad-1",
      metric_date: "2026-08-14",
      impressions: 10,
      clicks: 1,
      cost: "0.0000",
      sales: "0.0000",
      orders: 0,
      units: 0,
      currency: "USD",
      ...overrides,
    };
    this.tables.advertisedProductMetricsDaily.push(row);
    return row;
  }

  // -- query dispatch ---------------------------------------------------------

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const text = norm(sql);
    if (text === "begin" || text === "commit" || text === "rollback") {
      return this.ok();
    }
    for (const handler of this.handlers()) {
      if (text.includes(handler.match)) {
        return handler.handle(params, this, text);
      }
    }
    this.misses.push(text);
    throw new Error(`FakeDb: no handler for SQL: ${text}`);
  }

  /** A minimal Pool facade for withTransaction/createChangeSet. */
  asPool(): { query: FakeDb["query"]; connect: () => Promise<unknown> } {
    return {
      query: this.query.bind(this),
      connect: async () => ({
        query: this.query.bind(this),
        release: () => undefined,
      }),
    };
  }

  private profileForConnectionWorkspace(
    workspaceId: unknown,
    row: FakeRow,
  ): boolean {
    const connection = this.tables.amazonConnections.find(
      (c) => c.id === row.connection_id,
    );
    return connection?.workspace_id === workspaceId;
  }

  /**
   * Emulates the lateral fx_rates join of the converting dashboard queries:
   * the latest fixing at or before the fact date (USD is 1 by definition),
   * null when the stored rates do not cover the date.
   */
  private fxRateFor(currency: string, date: string): number | null {
    if (currency === "USD") return 1;
    let best: string | null = null;
    let rate: number | null = null;
    for (const row of this.tables.fxRates) {
      const rateDate = String(row.rate_date);
      if (
        row.quote_currency === currency &&
        rateDate <= date &&
        (best === null || rateDate > best)
      ) {
        best = rateDate;
        rate = Number(row.rate);
      }
    }
    return rate;
  }

  private latestFxRateDate(): string | null {
    let latest: string | null = null;
    for (const row of this.tables.fxRates) {
      const rateDate = String(row.rate_date);
      if (latest === null || rateDate > latest) latest = rateDate;
    }
    return latest;
  }

  /**
   * Accumulate one fact into a spend-explorer group row (spend/sales14d/
   * orders). With `converted`, the fact is cross-rated through the USD pivot
   * into `display` at its own date; an uncovered non-zero fact raises
   * rates_missing and contributes nothing, exactly like the SQL.
   */
  private accumulateSpendFact(
    row: FakeRow,
    fact: FakeRow,
    converted: boolean,
    display: string | null,
  ): void {
    const cost = Number(fact.cost);
    const sales = Number(fact.sales14d ?? fact.sales);
    row.orders = Number(row.orders) + Number(fact.purchases14d ?? fact.orders);
    if (!converted) {
      row.spend = Number(row.spend) + cost;
      row.sales = Number(row.sales) + sales;
      return;
    }
    const date = String(fact.metric_date);
    const dr = this.fxRateFor(display!, date);
    const nr = this.fxRateFor(String(fact.currency), date);
    if (dr === null || nr === null) {
      if (cost !== 0 || sales !== 0) row.rates_missing = true;
      return;
    }
    row.spend = Number(row.spend) + (cost * dr) / nr;
    row.sales = Number(row.sales) + (sales * dr) / nr;
  }

  /** Stringify the numeric group sums the way pg returns numeric sums. */
  private finalizeSpendRows(groups: Map<string, FakeRow>): FakeRow[] {
    return [...groups.values()].map((row) => ({
      ...row,
      spend: Number(row.spend).toFixed(4),
      sales: Number(row.sales).toFixed(4),
      orders: String(row.orders),
    }));
  }

  private handlers(): Handler[] {
    const t = this.tables;
    return [
      // -- sessions / login tokens / oauth states --------------------------
      {
        match: "insert into sessions",
        handle: (p) => {
          const row = {
            id: nextId(),
            user_id: p[0],
            token_hash: p[1],
            expires_at: p[2],
            created_at: new Date(),
            revoked_at: null,
            ip: p[3],
            user_agent: p[4],
          };
          t.sessions.push(row);
          return this.ok([row]);
        },
      },
      {
        match: "select * from sessions where token_hash = $1",
        handle: (p) =>
          this.ok(
            t.sessions.filter(
              (s) =>
                s.token_hash === p[0] &&
                s.revoked_at === null &&
                (s.expires_at as Date) > new Date(),
            ),
          ),
      },
      {
        match: "update sessions set revoked_at = now()",
        handle: (p) => {
          const row = t.sessions.find(
            (s) => s.token_hash === p[0] && s.revoked_at === null,
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.revoked_at = new Date();
          return { rows: [{ id: row.id }], rowCount: 1 };
        },
      },
      {
        match: "update sessions set expires_at = $2",
        handle: (p) => {
          const row = t.sessions.find(
            (s) =>
              s.token_hash === p[0] &&
              s.revoked_at === null &&
              (s.expires_at as Date) > new Date(),
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.expires_at = p[1];
          return { rows: [{ expires_at: row.expires_at }], rowCount: 1 };
        },
      },
      {
        match: "insert into login_tokens",
        handle: (p) => {
          const row = {
            id: nextId(),
            email: p[0],
            token_hash: p[1],
            expires_at: p[2],
            origin: p[3] ?? null,
            next_path: p[4] ?? null,
            used_at: null,
            created_at: new Date(),
          };
          t.loginTokens.push(row);
          return this.ok([{ id: row.id }]);
        },
      },
      {
        match: "update login_tokens set used_at = now()",
        handle: (p) => {
          const row = t.loginTokens.find(
            (r) =>
              r.token_hash === p[0] &&
              r.used_at === null &&
              (r.expires_at as Date) > new Date(),
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.used_at = new Date();
          return {
            rows: [
              {
                email: row.email,
                origin: row.origin,
                next_path: row.next_path ?? null,
              },
            ],
            rowCount: 1,
          };
        },
      },
      {
        match: "insert into oauth_states",
        handle: (p) => {
          const row = {
            id: nextId(),
            state_hash: p[0],
            user_id: p[1],
            return_to: p[2],
            expires_at: p[3],
            used_at: null,
            created_at: new Date(),
          };
          t.oauthStates.push(row);
          return this.ok([{ id: row.id }]);
        },
      },
      {
        match: "update oauth_states set used_at = now()",
        handle: (p) => {
          const row = t.oauthStates.find(
            (r) =>
              r.state_hash === p[0] &&
              r.used_at === null &&
              (r.expires_at as Date) > new Date(),
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.used_at = new Date();
          return {
            rows: [{ user_id: row.user_id, return_to: row.return_to }],
            rowCount: 1,
          };
        },
      },

      // -- identity ---------------------------------------------------------
      {
        match: "from users u left join workspace_members",
        handle: (p) =>
          this.ok(
            t.users
              .filter((u) => u.email === p[0])
              .map((u) => ({
                ...u,
                workspace_id:
                  t.workspaceMembers.find(
                    (m) => m.user_id === u.id && m.role === "owner",
                  )?.workspace_id ?? null,
              })),
          ),
      },
      {
        match: "insert into users",
        handle: (p) => {
          const existing = t.users.find((u) => u.email === p[0]);
          if (existing) return this.ok([existing]);
          const row = { id: nextId(), email: p[0], created_at: new Date() };
          t.users.push(row);
          return this.ok([row]);
        },
      },
      {
        match: "select * from users where email = $1",
        handle: (p) => this.ok(t.users.filter((u) => u.email === p[0])),
      },
      {
        match: "select email from users where id = $1",
        handle: (p) =>
          this.ok(
            t.users
              .filter((u) => u.id === p[0])
              .map((u) => ({ email: u.email })),
          ),
      },
      {
        match: "insert into workspaces",
        handle: (p) => {
          const row = { id: nextId(), name: p[0] };
          t.workspaces.push(row);
          return this.ok([{ id: row.id }]);
        },
      },
      {
        match: "insert into workspace_members",
        handle: (p) => {
          t.workspaceMembers.push({
            workspace_id: p[0],
            user_id: p[1],
            role: "owner",
          });
          return { rows: [], rowCount: 1 };
        },
      },
      {
        match: "select * from workspace_members where user_id = $1",
        handle: (p) =>
          this.ok(
            t.workspaceMembers.filter(
              (m) => m.user_id === p[0] && m.role === "owner",
            ),
          ),
      },

      // -- amazon connections -------------------------------------------------
      {
        match: "insert into amazon_connections",
        handle: (p) => {
          const row = {
            id: nextId(),
            workspace_id: p[0],
            encrypted_refresh_token: p[1],
            encryption_key_version: p[2],
            status: "connected",
            granted_at: new Date(),
            revoked_at: null,
            last_error_code: null,
            created_at: new Date(),
          };
          t.amazonConnections.push(row);
          return this.ok([row]);
        },
      },
      {
        match: "select * from amazon_connections where id = $1",
        handle: (p) =>
          this.ok(t.amazonConnections.filter((c) => c.id === p[0])),
      },
      {
        match: "and status <> 'disconnected' order by id desc",
        handle: (p) =>
          this.ok(
            t.amazonConnections
              .filter(
                (c) => c.workspace_id === p[0] && c.status !== "disconnected",
              )
              .slice(-1),
          ),
      },
      {
        match:
          "select * from amazon_connections where workspace_id = $1 order by id desc",
        handle: (p) =>
          this.ok(
            t.amazonConnections
              .filter((c) => c.workspace_id === p[0])
              .slice(-1),
          ),
      },
      {
        match: "update amazon_connections set status = 'disconnected'",
        handle: (p) => {
          const row = t.amazonConnections.find(
            (c) => c.id === p[0] && c.status !== "disconnected",
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.status = "disconnected";
          row.revoked_at = new Date();
          row.encrypted_refresh_token = Buffer.alloc(0);
          return { rows: [{ id: row.id }], rowCount: 1 };
        },
      },
      {
        match: "update amazon_connections set status = $2",
        handle: (p) => {
          const row = t.amazonConnections.find((c) => c.id === p[0]);
          if (!row) return { rows: [], rowCount: 0 };
          row.status = p[1];
          if (p[2] !== null) row.last_error_code = p[2];
          return { rows: [{ id: row.id }], rowCount: 1 };
        },
      },

      // -- amazon profiles ----------------------------------------------------
      {
        match: "and p.profile_id = $2",
        handle: (p, db) =>
          this.ok(
            t.amazonProfiles.filter(
              (r) =>
                r.profile_id === p[1] &&
                db.profileForConnectionWorkspace(p[0], r),
            ),
          ),
      },
      {
        match: "select p.* from amazon_profiles p join amazon_connections",
        handle: (p, db) =>
          this.ok(
            t.amazonProfiles.filter((r) =>
              db.profileForConnectionWorkspace(p[0], r),
            ),
          ),
      },
      {
        match: "select * from amazon_profiles where id = $1",
        handle: (p) => this.ok(t.amazonProfiles.filter((r) => r.id === p[0])),
      },
      {
        match: "insert into amazon_profiles",
        handle: (p) => {
          const row = {
            id: nextId(),
            connection_id: p[0],
            profile_id: p[1],
            account_id: p[2],
            region: p[3],
            country_code: p[4],
            currency_code: p[5],
            timezone: p[6],
            account_type: p[7],
            enabled: false,
            write_enabled: false,
          };
          t.amazonProfiles.push(row);
          return this.ok([row]);
        },
      },

      // -- queue ---------------------------------------------------------------
      {
        // enqueueIfNotQueued: payload-containment dedupe on pending/running.
        match: "select id::text from job_queue",
        handle: (p) => {
          const payload = JSON.parse(p[1] as string) as Record<string, unknown>;
          const hit = t.jobQueue.find(
            (j) =>
              j.type === p[0] &&
              ["pending", "running"].includes(String(j.status)) &&
              Object.entries(payload).every(
                ([key, value]) =>
                  JSON.stringify(
                    (j.payload as Record<string, unknown> | null)?.[key],
                  ) === JSON.stringify(value),
              ),
          );
          return this.ok(hit ? [{ id: hit.id }] : []);
        },
      },
      {
        match: "insert into job_queue",
        handle: (p) => {
          const row = {
            id: nextId(),
            type: p[0],
            payload: JSON.parse(p[1] as string),
            status: "pending",
            last_error: null,
          };
          t.jobQueue.push(row);
          return this.ok([{ id: row.id }]);
        },
      },
      {
        match: "update job_queue set status = 'failed'",
        handle: (p) => {
          const ids = p[0] as string[];
          const hits = t.jobQueue.filter(
            (j) =>
              j.status === "pending" &&
              ids.includes(
                (j.payload as { profileId?: string } | null)
                  ?.profileId as string,
              ),
          );
          for (const hit of hits) {
            hit.status = "failed";
            hit.last_error = p[1];
          }
          return {
            rows: hits.map((h) => ({ id: h.id })),
            rowCount: hits.length,
          };
        },
      },

      // -- sync runs ------------------------------------------------------------
      {
        match: "insert into sync_runs",
        handle: (p) => {
          const row = {
            id: nextId(),
            profile_id: p[0],
            kind: p[1],
            status: "running",
            started_at: new Date(),
            finished_at: null,
            error: null,
          };
          t.syncRuns.push(row);
          return this.ok([{ id: row.id }]);
        },
      },
      {
        match: "select * from sync_runs where id = $1",
        handle: (p) => this.ok(t.syncRuns.filter((r) => r.id === p[0])),
      },
      {
        match: "from sync_runs r join amazon_profiles",
        handle: (p) => {
          const rows = t.syncRuns
            .map((r) => {
              const profile = t.amazonProfiles.find(
                (ap) => ap.id === r.profile_id,
              );
              const connection = profile
                ? t.amazonConnections.find(
                    (c) => c.id === profile.connection_id,
                  )
                : undefined;
              return { r, profile, connection };
            })
            .filter(
              ({ profile, connection }) =>
                profile && connection && connection.workspace_id === p[0],
            )
            .sort((a, b) => {
              const byStarted =
                new Date(b.r.started_at as string | Date).getTime() -
                new Date(a.r.started_at as string | Date).getTime();
              if (byStarted !== 0) return byStarted;
              return String(b.r.id).localeCompare(String(a.r.id), undefined, {
                numeric: true,
              });
            })
            .slice(0, p[1] as number)
            .map(({ r, profile }) => ({
              ...r,
              amazon_profile_id: profile!.profile_id,
            }));
          return this.ok(rows);
        },
      },
      {
        match: "from report_jobs where sync_run_id = any($1)",
        handle: (p) =>
          this.ok(
            t.reportJobs
              .filter((j) =>
                (p[0] as string[]).includes(j.sync_run_id as string),
              )
              .sort((a, b) =>
                String(a.id).localeCompare(String(b.id), undefined, {
                  numeric: true,
                }),
              ),
          ),
      },

      // -- audit -----------------------------------------------------------------
      {
        match: "insert into audit_events",
        handle: (p) => {
          const row = {
            id: nextId(),
            workspace_id: p[0],
            actor_user_id: p[1],
            event: p[2],
            entity_type: p[3],
            entity_id: p[4],
            ip: p[5],
            session_id: p[6],
            details: JSON.parse(p[7] as string),
            created_at: new Date(),
          };
          t.auditEvents.push(row);
          return this.ok([row]);
        },
      },
      {
        match: "select * from audit_events where workspace_id = $1",
        handle: (p) =>
          this.ok(t.auditEvents.filter((r) => r.workspace_id === p[0])),
      },

      // -- recommendations ---------------------------------------------------------
      {
        match: "select inputs from recommendation_evidence",
        handle: (p) =>
          this.ok(
            t.recommendationEvidence.filter(
              (row) => row.recommendation_id === p[0],
            ),
          ),
      },
      {
        match: "from recommendations r join amazon_profiles",
        handle: (p, db, text) => {
          const rows = t.recommendations
            .filter((r) => {
              const profile = t.amazonProfiles.find(
                (ap) => ap.id === r.profile_id,
              );
              return (
                profile !== undefined &&
                db.profileForConnectionWorkspace(p[0], profile)
              );
            })
            .map((r): FakeRow => {
              const campaign = t.campaigns.find((c) => c.id === r.campaign_id);
              return {
                ...r,
                amazon_profile_id: t.amazonProfiles.find(
                  (ap) => ap.id === r.profile_id,
                )!.profile_id,
                amazon_campaign_id: campaign?.amazon_campaign_id ?? null,
                campaign_name: campaign?.name ?? null,
                campaign_state: campaign?.state ?? null,
              };
            });
          if (text.includes("and r.id = $2")) {
            return this.ok(rows.filter((r) => r.id === p[1]));
          }
          return this.ok(
            rows.filter(
              (r) =>
                (p[1] === null || r.type === p[1]) &&
                (p[2] === null || r.state === p[2]),
            ),
          );
        },
      },
      {
        match: "update recommendations set state = $3",
        handle: (p) => {
          const row = t.recommendations.find(
            (r) => r.id === p[0] && r.state === p[1],
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.state = p[2];
          return { rows: [row], rowCount: 1 };
        },
      },
      {
        match: "insert into recommendation_dismissals",
        handle: (p) => {
          const searchTerm =
            typeof p[5] === "string" ? p[5].trim().toLowerCase() || null : null;
          const identity = {
            profile_id: p[0],
            type: p[1],
            campaign_id: p[2],
            ad_group_id: p[3],
            target_id: p[4],
            search_term: searchTerm,
          };
          const existing = t.recommendationDismissals.find((row) =>
            Object.entries(identity).every(
              ([key, value]) => row[key] === value,
            ),
          );
          const dismissal = {
            ...identity,
            recommendation_id: p[6],
            dismissed_at: new Date(),
            dismissed_until: p[7],
          };
          if (existing) Object.assign(existing, dismissal);
          else t.recommendationDismissals.push(dismissal);
          return this.ok();
        },
      },
      {
        match: "from recommendation_dismissals",
        handle: (p) => {
          const searchTerm =
            typeof p[5] === "string" ? p[5].trim().toLowerCase() || null : null;
          const now = p[6] ? new Date(p[6] as string) : new Date();
          return this.ok(
            t.recommendationDismissals.filter(
              (row) =>
                row.profile_id === p[0] &&
                row.type === p[1] &&
                row.campaign_id === p[2] &&
                row.ad_group_id === p[3] &&
                row.target_id === p[4] &&
                row.search_term === searchTerm &&
                (row.dismissed_until === null ||
                  new Date(row.dismissed_until as string) > now),
            ),
          );
        },
      },

      // -- change sets / actions -----------------------------------------------------
      {
        match: "from campaign_bid_policies where campaign_id = $1",
        handle: (p) =>
          this.ok(
            t.campaignBidPolicies.filter((row) => row.campaign_id === p[0]),
          ),
      },
      {
        match: "select pg_advisory_xact_lock",
        handle: () => this.ok(),
      },
      {
        match: "select * from change_sets where fingerprint = $1",
        handle: (p) =>
          this.ok(t.changeSets.filter((r) => r.fingerprint === p[0])),
      },
      {
        match: "insert into change_sets",
        handle: (p) => {
          const row = {
            id: nextId(),
            profile_id: p[0],
            creator_user_id: p[1],
            status: "draft",
            guardrail_result: p[3] === null ? null : JSON.parse(p[3] as string),
            fingerprint: p[2],
            created_at: new Date(),
            applied_at: null,
            kind: p[4],
            metadata: JSON.parse(p[5] as string),
          };
          t.changeSets.push(row);
          return this.ok([row]);
        },
      },
      {
        match: "insert into change_actions",
        handle: (p) => {
          const row = {
            id: nextId(),
            change_set_id: p[0],
            recommendation_id: p[1],
            action_type: p[2],
            campaign_id: p[3],
            ad_group_id: p[4],
            target_id: p[5],
            search_term: p[6],
            before_value: p[7],
            after_value: p[8],
            fingerprint: p[9],
            rollback_of_id: p[10],
            amazon_entity_id: p[11],
            entity_name: p[12],
            before_state: p[13] === null ? null : JSON.parse(p[13] as string),
            after_state: p[14] === null ? null : JSON.parse(p[14] as string),
            status: "pending",
            amazon_request: null,
            amazon_response: null,
            amazon_request_id: null,
            verified_at: null,
            created_at: new Date(),
          };
          t.changeActions.push(row);
          return this.ok([row]);
        },
      },
      {
        match: "from change_actions ca join change_sets cs",
        handle: (p, db) =>
          this.ok(
            t.changeActions
              .filter((a) => {
                if (a.id !== p[1]) return false;
                const set = t.changeSets.find((s) => s.id === a.change_set_id);
                const profile = t.amazonProfiles.find(
                  (ap) => ap.id === set?.profile_id,
                );
                return (
                  profile !== undefined &&
                  db.profileForConnectionWorkspace(p[0], profile)
                );
              })
              .map((a) => {
                const set = t.changeSets.find((s) => s.id === a.change_set_id)!;
                const profile = t.amazonProfiles.find(
                  (ap) => ap.id === set.profile_id,
                )!;
                return {
                  ...a,
                  profile_pk: set.profile_id,
                  amazon_profile_id: profile.profile_id,
                  creator_user_id: set.creator_user_id,
                };
              }),
          ),
      },
      {
        match: "left join campaigns c on c.id = ca.campaign_id",
        handle: (p) =>
          this.ok(
            t.changeActions
              .filter((r) => r.change_set_id === p[0])
              .map((r) => {
                const campaign = t.campaigns.find(
                  (c) => c.id === r.campaign_id,
                );
                return {
                  ...r,
                  campaign_name: campaign?.name ?? null,
                  amazon_campaign_id: campaign?.amazon_campaign_id ?? null,
                };
              }),
          ),
      },
      {
        match: "select * from change_actions where id = $1",
        handle: (p) => this.ok(t.changeActions.filter((r) => r.id === p[0])),
      },
      {
        match: "from change_sets cs join amazon_profiles",
        handle: (p, db, text) => {
          const rows = t.changeSets
            .filter((s) => {
              const profile = t.amazonProfiles.find(
                (ap) => ap.id === s.profile_id,
              );
              return (
                profile !== undefined &&
                db.profileForConnectionWorkspace(p[0], profile)
              );
            })
            .map((s): FakeRow => ({
              ...s,
              amazon_profile_id: t.amazonProfiles.find(
                (ap) => ap.id === s.profile_id,
              )!.profile_id,
            }));
          if (text.includes("and cs.id = $2")) {
            return this.ok(rows.filter((r) => r.id === p[1]));
          }
          return this.ok(rows);
        },
      },
      {
        match: "and status = any($2::text[])",
        handle: (p) => {
          const row = t.changeSets.find(
            (s) =>
              s.id === p[0] && (p[1] as string[]).includes(s.status as string),
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.status = p[2];
          if (p[3] !== null) row.guardrail_result = JSON.parse(p[3] as string);
          if (p[2] === "applied" || p[2] === "partially_applied") {
            row.applied_at = new Date();
          }
          return { rows: [row], rowCount: 1 };
        },
      },
      {
        match: "update change_actions set status = $2",
        handle: (p) => {
          const row = t.changeActions.find((a) => a.id === p[0]);
          if (!row) return { rows: [], rowCount: 0 };
          row.status = p[1];
          if (p[2] !== null) row.amazon_request = JSON.parse(p[2] as string);
          if (p[3] !== null) row.amazon_response = JSON.parse(p[3] as string);
          if (p[4] !== null) row.amazon_request_id = p[4];
          if (p[5] !== null) row.verified_at = p[5];
          if (p[6] !== null) row.amazon_entity_id = p[6];
          return { rows: [row], rowCount: 1 };
        },
      },
      {
        match: "select ca.action_type, coalesce(ca.target_id::text",
        handle: (p) => {
          const since = new Date(p[1] as string);
          const rows = t.changeActions
            .filter((a) => {
              const set = t.changeSets.find((s) => s.id === a.change_set_id);
              return (
                set !== undefined &&
                set.profile_id === p[0] &&
                a.status === "applied" &&
                set.applied_at !== null &&
                (set.applied_at as Date) >= since
              );
            })
            .map((a) => {
              const set = t.changeSets.find((s) => s.id === a.change_set_id)!;
              return {
                action_type: a.action_type,
                target_id: a.target_id ?? a.amazon_entity_id,
                campaign_id: a.campaign_id,
                search_term: a.search_term,
                applied_at: set.applied_at,
                change_set_id: set.id,
              };
            });
          return this.ok(rows);
        },
      },

      // -- structure ------------------------------------------------------------------
      {
        match: "select c.id, c.profile_id, c.amazon_campaign_id",
        handle: (p, db) =>
          this.ok(
            t.campaigns
              .filter((c) => {
                if (c.amazon_campaign_id !== p[1]) return false;
                const profile = t.amazonProfiles.find(
                  (ap) => ap.id === c.profile_id,
                );
                return (
                  profile !== undefined &&
                  db.profileForConnectionWorkspace(p[0], profile)
                );
              })
              .map((c) => ({
                ...c,
                amazon_profile_id: t.amazonProfiles.find(
                  (ap) => ap.id === c.profile_id,
                )!.profile_id,
              })),
          ),
      },
      {
        match: "from campaigns where id = $1",
        handle: (p) => this.ok(t.campaigns.filter((r) => r.id === p[0])),
      },
      {
        match: "update campaigns",
        handle: (p) => {
          const row = t.campaigns.find((r) => r.id === p[0]);
          if (row) {
            if (p[1] !== null) row.name = String(p[1]);
            if (p[2] !== null) row.state = String(p[2]);
          }
          return this.ok([]);
        },
      },
      {
        match: "from ad_groups where id = $1",
        handle: (p) => this.ok(t.adGroups.filter((r) => r.id === p[0])),
      },
      {
        match: "from targets where id = $1",
        handle: (p) => this.ok(t.targets.filter((r) => r.id === p[0])),
      },

      // -- campaign metrics ----------------------------------------------------
      {
        match: "select currency, sum(impressions)::text as impressions",
        handle: (p) => {
          // metrics.dashboardTotals: per-currency totals; the repository
          // throws MixedCurrencyError when more than one row comes back.
          const profileId = String(p[0]);
          const start = String(p[1]);
          const end = String(p[2]);
          const byCurrency = new Map<string, FakeRow>();
          for (const fact of t.campaignMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              String(fact.profile_id) !== profileId ||
              date < start ||
              date > end
            ) {
              continue;
            }
            const currency = String(fact.currency);
            const row = byCurrency.get(currency) ?? {
              currency,
              impressions: 0,
              clicks: 0,
              cost: 0,
              sales: 0,
              orders: 0,
              units: 0,
            };
            row.impressions =
              Number(row.impressions) + Number(fact.impressions);
            row.clicks = Number(row.clicks) + Number(fact.clicks);
            row.cost = Number(row.cost) + Number(fact.cost);
            row.sales = Number(row.sales) + Number(fact.sales14d ?? fact.sales);
            row.orders =
              Number(row.orders) + Number(fact.purchases14d ?? fact.orders);
            row.units =
              Number(row.units) +
              Number(fact.units_sold_clicks14d ?? fact.units);
            byCurrency.set(currency, row);
          }
          return this.ok(
            [...byCurrency.values()].map((row) => ({
              currency: row.currency,
              impressions: String(row.impressions),
              clicks: String(row.clicks),
              cost: Number(row.cost).toFixed(4),
              sales: Number(row.sales).toFixed(4),
              orders: String(row.orders),
              units: String(row.units),
            })),
          );
        },
      },
      {
        match:
          "from search_term_metrics_daily m where m.profile_id = $1 and m.campaign_id = $2",
        handle: (p) => {
          const totals = new Map<string, FakeRow>();
          for (const fact of t.searchTermMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              fact.profile_id !== p[0] ||
              fact.campaign_id !== p[1] ||
              date < String(p[2]) ||
              date > String(p[3])
            ) {
              continue;
            }
            const term = String(fact.search_term);
            const row = totals.get(term) ?? {
              search_term: term,
              impressions: 0,
              clicks: 0,
              cost: 0,
              sales: 0,
              orders: 0,
              units: 0,
              estimated_royalty: null,
              economics_missing: true,
            };
            row.impressions =
              Number(row.impressions) + Number(fact.impressions);
            row.clicks = Number(row.clicks) + Number(fact.clicks);
            row.cost = Number(row.cost) + Number(fact.cost);
            row.sales = Number(row.sales) + Number(fact.sales14d ?? fact.sales);
            row.orders =
              Number(row.orders) + Number(fact.purchases14d ?? fact.orders);
            row.units =
              Number(row.units) +
              Number(fact.units_sold_clicks14d ?? fact.units);
            totals.set(term, row);
          }
          // The real query returns numeric sums as strings, highest spend first.
          return this.ok(
            [...totals.values()]
              .sort((left, right) => Number(right.cost) - Number(left.cost))
              .map((row) => ({
                ...row,
                impressions: String(row.impressions),
                clicks: String(row.clicks),
                cost: Number(row.cost).toFixed(4),
                sales: Number(row.sales).toFixed(4),
                orders: String(row.orders),
                units: String(row.units),
              })),
          );
        },
      },

      {
        match: "delete from negative_keywords",
        handle: (p) => {
          const before = t.negativeKeywords.length;
          t.negativeKeywords = t.negativeKeywords.filter(
            (n) =>
              !(n.profile_id === p[0] && n.amazon_negative_keyword_id === p[1]),
          );
          return { rows: [], rowCount: before - t.negativeKeywords.length };
        },
      },
      {
        match: "delete from negative_targets",
        handle: (p) => {
          const before = t.negativeTargets.length;
          t.negativeTargets = t.negativeTargets.filter(
            (n) =>
              !(n.profile_id === p[0] && n.amazon_negative_target_id === p[1]),
          );
          return { rows: [], rowCount: before - t.negativeTargets.length };
        },
      },
      {
        match: "and amazon_negative_keyword_id = $2",
        handle: (p) => {
          const row = t.negativeKeywords.find(
            (n) =>
              n.campaign_id === p[0] && n.amazon_negative_keyword_id === p[1],
          );
          return this.ok(row ? [row] : []);
        },
      },
      {
        match: "and amazon_negative_target_id = $2",
        handle: (p) => {
          const row = t.negativeTargets.find(
            (n) =>
              n.campaign_id === p[0] && n.amazon_negative_target_id === p[1],
          );
          return this.ok(row ? [row] : []);
        },
      },
      {
        match: "from negative_keywords n",
        handle: (p) => {
          const rows = t.negativeKeywords
            .filter((n) => n.campaign_id === p[0])
            .map((n) => {
              const adGroup = t.adGroups.find((g) => g.id === n.ad_group_id);
              return {
                amazon_negative_keyword_id: n.amazon_negative_keyword_id,
                keyword_text: n.keyword_text,
                match_type: n.match_type,
                amazon_ad_group_id: adGroup?.amazon_ad_group_id ?? null,
                ad_group_name: adGroup?.name ?? null,
                state: n.state,
              };
            });
          return this.ok(rows);
        },
      },
      {
        match: "from negative_targets n",
        handle: (p) => {
          const rows = t.negativeTargets
            .filter((n) => n.campaign_id === p[0])
            .map((n) => {
              const adGroup = t.adGroups.find((g) => g.id === n.ad_group_id);
              return {
                amazon_negative_target_id: n.amazon_negative_target_id,
                expression_asin: n.expression_asin,
                amazon_ad_group_id: adGroup?.amazon_ad_group_id ?? null,
                ad_group_name: adGroup?.name ?? null,
                state: n.state,
              };
            });
          return this.ok(rows);
        },
      },
      {
        match: "from campaigns where profile_id = $1",
        handle: (p) =>
          this.ok(t.campaigns.filter((c) => c.profile_id === p[0])),
      },
      {
        match: "from negative_keywords where profile_id = $1",
        handle: (p) =>
          this.ok(t.negativeKeywords.filter((n) => n.profile_id === p[0])),
      },
      {
        match: "from negative_targets where profile_id = $1",
        handle: (p) =>
          this.ok(t.negativeTargets.filter((n) => n.profile_id === p[0])),
      },

      // -- search term exclusions ----------------------------------------------
      {
        match: "select distinct m.profile_id::text as profile_pk",
        handle: (p, db) => {
          const seen = new Set<string>();
          const rows: FakeRow[] = [];
          for (const metric of t.searchTermMetricsDaily) {
            const profile = t.amazonProfiles.find(
              (row) => row.id === metric.profile_id,
            );
            if (!profile || !db.profileForConnectionWorkspace(p[0], profile)) {
              continue;
            }
            const metricDate = String(metric.metric_date);
            if (metricDate < (p[1] as string) || metricDate > (p[2] as string))
              continue;
            if (String(metric.search_term).toLowerCase() !== (p[3] as string))
              continue;
            const campaign = t.campaigns.find(
              (row) =>
                row.profile_id === metric.profile_id &&
                row.amazon_campaign_id === metric.campaign_id,
            );
            if (!campaign) continue;
            const key = `${profile.id}|${campaign.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({
              profile_pk: String(profile.id),
              campaign_pk: String(campaign.id),
            });
          }
          return this.ok(rows);
        },
      },
      {
        match: "insert into search_term_exclusions",
        handle: (p) => {
          const existing = t.searchTermExclusions.find(
            (row) => row.workspace_id === p[0] && row.search_term === p[1],
          );
          // ON CONFLICT DO NOTHING: no row returned, the repository re-selects.
          if (existing) return this.ok([]);
          const row = {
            id: nextId(),
            workspace_id: p[0],
            search_term: p[1],
            created_at: new Date(),
          };
          t.searchTermExclusions.push(row);
          return this.ok([row]);
        },
      },
      {
        // Must precede the select handlers: the DELETE text contains their
        // match strings too.
        match: "delete from search_term_exclusions",
        handle: (p) => {
          const before = t.searchTermExclusions.length;
          t.searchTermExclusions = t.searchTermExclusions.filter(
            (row) => !(row.workspace_id === p[0] && row.search_term === p[1]),
          );
          return {
            rows: [],
            rowCount: before - t.searchTermExclusions.length,
          };
        },
      },
      {
        match:
          "from search_term_exclusions where workspace_id = $1 and search_term = $2",
        handle: (p) =>
          this.ok(
            t.searchTermExclusions.filter(
              (row) => row.workspace_id === p[0] && row.search_term === p[1],
            ),
          ),
      },
      {
        match: "from search_term_exclusions",
        handle: (p) =>
          this.ok(
            t.searchTermExclusions.filter((row) => row.workspace_id === p[0]),
          ),
      },

      // -- books -----------------------------------------------------------------
      {
        match: "as asin_mismatch",
        handle: (p, db) => {
          const bookId = String(p[0]);
          const profilePks = (p[1] as string[]).map(String);
          const workspaceId = p[2];
          const asin = String(p[3]);
          const book = t.books.find(
            (row) => row.id === bookId && row.workspace_id === workspaceId,
          );
          const selected = profilePks.map((id) =>
            t.amazonProfiles.find(
              (row) =>
                row.id === id &&
                db.profileForConnectionWorkspace(workspaceId, row),
            ),
          );
          const bookOk = book !== undefined;
          const profilesOk =
            selected.length === profilePks.length &&
            selected.every((row) => row !== undefined);
          const asinMismatch = profilePks.some((profileId) =>
            t.bookProfileLinks.some(
              (link) =>
                link.book_id === bookId &&
                link.profile_id === profileId &&
                link.marketplace_asin !== asin,
            ),
          );
          const asinTaken = profilePks.some((profileId) =>
            t.bookProfileLinks.some(
              (link) =>
                link.profile_id === profileId &&
                link.marketplace_asin === asin &&
                link.book_id !== bookId,
            ),
          );
          if (!bookOk || !profilesOk || asinMismatch || asinTaken) {
            return this.ok([
              {
                book_ok: bookOk,
                profiles_ok: profilesOk,
                asin_mismatch: asinMismatch,
                asin_taken: asinTaken,
                linked_count: 0,
              },
            ]);
          }
          for (const profileId of profilePks) {
            const existing = t.bookProfileLinks.find(
              (link) =>
                link.book_id === bookId && link.profile_id === profileId,
            );
            if (existing) {
              existing.marketplace_asin = asin;
              existing.enabled = true;
            } else {
              t.bookProfileLinks.push({
                book_id: bookId,
                profile_id: profileId,
                marketplace_asin: asin,
                enabled: true,
              });
            }
          }
          return this.ok([
            {
              book_ok: true,
              profiles_ok: true,
              asin_mismatch: false,
              asin_taken: false,
              linked_count: profilePks.length,
            },
          ]);
        },
      },
      {
        match: "select distinct on (be.book_id, be.profile_id)",
        handle: (p) => {
          const today = new Date().toISOString().slice(0, 10);
          const latest = new Map<string, FakeRow>();
          for (const row of t.bookEconomics) {
            const book = t.books.find((b) => b.id === row.book_id);
            if (!book || book.workspace_id !== p[0]) continue;
            if (String(row.effective_from) > today) continue;
            const key = `${row.book_id}:${row.profile_id}`;
            const current = latest.get(key);
            if (
              !current ||
              String(row.effective_from) > String(current.effective_from) ||
              (String(row.effective_from) === String(current.effective_from) &&
                Number(row.id) > Number(current.id))
            ) {
              latest.set(key, row);
            }
          }
          return this.ok(
            [...latest.values()].map((row) => ({
              ...row,
              amazon_profile_id: t.amazonProfiles.find(
                (ap) => ap.id === row.profile_id,
              )?.profile_id,
            })),
          );
        },
      },
      {
        match: "select distinct b.id as book_id",
        handle: (p) => {
          const adGroups = t.adGroups.filter((g) => g.campaign_id === p[0]);
          const rows: FakeRow[] = [];
          for (const group of adGroups) {
            for (const ad of t.ads.filter(
              (a) =>
                a.ad_group_id === group.id && a.profile_id === group.profile_id,
            )) {
              const link = t.bookProfileLinks.find(
                (l) =>
                  l.profile_id === group.profile_id &&
                  l.marketplace_asin === ad.asin &&
                  l.enabled === true,
              );
              const book = t.books.find((b) => b.id === link?.book_id);
              if (!link || !book) continue;
              if (rows.some((row) => row.book_id === book.id)) continue;
              rows.push({
                book_id: book.id,
                title: book.title,
                marketplace_asin: link.marketplace_asin,
                cover_json: book.cover_json,
              });
            }
          }
          return this.ok(rows);
        },
      },
      {
        // listBooks (workspace filter) — must precede the getBook handler,
        // whose match "from books b" would capture this query otherwise.
        match: "b.workspace_id = $1 group by b.id",
        handle: (p) =>
          this.ok(
            t.books
              .filter((b) => b.workspace_id === p[0])
              .sort((a, b) => Number(a.id) - Number(b.id))
              .map((b) => ({
                ...b,
                profile_ids: t.bookProfileLinks
                  .filter((l) => l.book_id === b.id && l.enabled === true)
                  .map(
                    (l) =>
                      t.amazonProfiles.find((ap) => ap.id === l.profile_id)
                        ?.profile_id,
                  )
                  .filter((id) => id !== undefined)
                  .sort(),
                marketplace_asins: t.bookProfileLinks
                  .filter((l) => l.book_id === b.id && l.enabled === true)
                  .map((l) => ({
                    profileId: t.amazonProfiles.find(
                      (ap) => ap.id === l.profile_id,
                    )?.profile_id,
                    asin: l.marketplace_asin,
                  }))
                  .sort((left, right) =>
                    String(left.profileId).localeCompare(
                      String(right.profileId),
                    ),
                  ),
              })),
          ),
      },
      {
        match: "from books b",
        handle: (p) =>
          this.ok(
            t.books
              .filter((b) => b.id === p[0])
              .map((b) => ({
                ...b,
                marketplace_asins: t.bookProfileLinks
                  .filter((l) => l.book_id === b.id && l.enabled === true)
                  .map((l) => ({
                    profileId: t.amazonProfiles.find(
                      (ap) => ap.id === l.profile_id,
                    )?.profile_id,
                    asin: l.marketplace_asin,
                  }))
                  .sort((left, right) =>
                    String(left.profileId).localeCompare(
                      String(right.profileId),
                    ),
                  ),
              })),
          ),
      },

      // -- kdp royalty imports ------------------------------------------------
      {
        match: "insert into kdp_royalty_imports",
        handle: (p) => {
          const existing = t.kdpRoyaltyImports.find(
            (row) => row.workspace_id === p[0] && row.payload_sha256 === p[2],
          );
          // ON CONFLICT DO NOTHING: no row returned, the repository re-selects.
          if (existing) return this.ok([]);
          const row = {
            id: nextId(),
            workspace_id: p[0],
            file_name: p[1],
            payload_sha256: p[2],
            period_start: p[3],
            period_end: p[4],
            row_count: p[5],
            suggestions: JSON.parse(String(p[6])),
            skipped: JSON.parse(String(p[7])),
            rows: JSON.parse(String(p[8])),
            created_at: new Date(),
            applied_at: null,
          };
          t.kdpRoyaltyImports.push(row);
          return this.ok([row]);
        },
      },
      {
        match: "update kdp_royalty_imports",
        handle: (p) => {
          const row = t.kdpRoyaltyImports.find(
            (r) =>
              r.workspace_id === p[0] && r.id === p[1] && r.applied_at === null,
          );
          if (!row) return { rows: [], rowCount: 0 };
          row.applied_at = new Date();
          return { rows: [row], rowCount: 1 };
        },
      },
      {
        match:
          "from kdp_royalty_imports where workspace_id = $1 and payload_sha256 = $2",
        handle: (p) =>
          this.ok(
            t.kdpRoyaltyImports.filter(
              (r) => r.workspace_id === p[0] && r.payload_sha256 === p[1],
            ),
          ),
      },
      {
        match: "from kdp_royalty_imports where workspace_id = $1 and id = $2",
        handle: (p) =>
          this.ok(
            t.kdpRoyaltyImports.filter(
              (r) => r.workspace_id === p[0] && r.id === p[1],
            ),
          ),
      },
      {
        match: "select id, file_name, rows, created_at",
        handle: (p) =>
          this.ok(t.kdpRoyaltyImports.filter((r) => r.workspace_id === p[0])),
      },
      {
        match: "from kdp_royalty_imports",
        handle: (p) =>
          this.ok(
            t.kdpRoyaltyImports
              .filter((r) => r.workspace_id === p[0])
              .sort((a, b) => Number(b.id) - Number(a.id)),
          ),
      },

      // -- kdp sales history ------------------------------------------------
      {
        // Derived monthly aggregates over the transactions
        // (listKdpMonthlyBookSales): royalty_date month, standard/expanded
        // split on the same classification as the SQL.
        match: "coalesce(sum(net_units) filter",
        handle: (p) => {
          const standard = (row: FakeRow) =>
            !["40%", "50%"].includes(String(row.royalty_type)) &&
            !String(row.transaction_type)
              .toLowerCase()
              .startsWith("expanded distribution");
          interface MonthlyGroup {
            book_id: unknown;
            profile_id: unknown;
            month: string;
            standard_units: number;
            expanded_units: number;
            royalty: number;
            currency: unknown;
          }
          const groups = new Map<string, MonthlyGroup>();
          for (const row of t.kdpSaleTransactions) {
            if (row.workspace_id !== p[0]) continue;
            if (row.book_id === null || row.profile_id === null) continue;
            const month = `${dateOnly(row.royalty_date).slice(0, 7)}-01`;
            const key = `${row.book_id} ${row.profile_id} ${month}`;
            const group = groups.get(key) ?? {
              book_id: row.book_id,
              profile_id: row.profile_id,
              month,
              standard_units: 0,
              expanded_units: 0,
              royalty: 0,
              currency: row.currency,
            };
            if (standard(row)) {
              group.standard_units += Number(row.net_units);
              group.royalty += Number(row.royalty);
            } else {
              group.expanded_units += Number(row.net_units);
            }
            groups.set(key, group);
          }
          return this.ok(
            [...groups.values()]
              .sort(
                (a, b) =>
                  String(a.month).localeCompare(String(b.month)) ||
                  String(a.book_id).localeCompare(
                    String(b.book_id),
                    undefined,
                    { numeric: true },
                  ) ||
                  String(a.profile_id).localeCompare(
                    String(b.profile_id),
                    undefined,
                    { numeric: true },
                  ),
              )
              .map((group) => ({
                ...group,
                royalty: Number(group.royalty).toFixed(4),
              })),
          );
        },
      },
      {
        // mergeKdpSaleTransactions: delete rows identical to the incoming
        // ones on every report field; the caller then re-inserts them.
        match: "delete from kdp_sale_transactions",
        handle: (p) => {
          const count = (p[1] as string[]).length;
          const matches = (row: FakeRow): boolean => {
            for (let i = 0; i < count; i += 1) {
              if (
                row.asin === (p[1] as string[])[i] &&
                row.marketplace === (p[2] as string[])[i] &&
                dateOnly(row.order_date) === dateOnly((p[3] as unknown[])[i]) &&
                dateOnly(row.royalty_date) ===
                  dateOnly((p[4] as unknown[])[i]) &&
                row.royalty_type === (p[5] as string[])[i] &&
                row.transaction_type === (p[6] as string[])[i] &&
                Number(row.net_units) === Number((p[7] as number[])[i]) &&
                Number(row.royalty) === Number((p[8] as unknown[])[i]) &&
                row.currency === (p[9] as string[])[i] &&
                row.format === (p[10] as string[])[i]
              ) {
                return true;
              }
            }
            return false;
          };
          const kept = t.kdpSaleTransactions.filter(
            (row) => !(row.workspace_id === p[0] && matches(row)),
          );
          const removed = t.kdpSaleTransactions.length - kept.length;
          t.kdpSaleTransactions.splice(
            0,
            t.kdpSaleTransactions.length,
            ...kept,
          );
          return { rows: [], rowCount: removed };
        },
      },
      {
        match: "insert into kdp_sale_transactions",
        handle: (p) => {
          t.kdpSaleTransactions.push({
            id: nextId(),
            workspace_id: p[0],
            import_id: p[1],
            book_id: p[2],
            profile_id: p[3],
            asin: p[4],
            marketplace: p[5],
            format: p[6],
            royalty_type: p[7],
            transaction_type: p[8],
            order_date: p[9],
            royalty_date: p[10],
            net_units: p[11],
            royalty: p[12],
            currency: p[13],
          });
          return { rows: [], rowCount: 1 };
        },
      },
      {
        match: "select count(*)::int as total from kdp_sale_transactions",
        handle: (p) =>
          this.ok([
            {
              total: t.kdpSaleTransactions.filter(
                (row) =>
                  row.workspace_id === p[0] &&
                  (p[1] === null || row.book_id === p[1]) &&
                  (p[2] === null || row.profile_id === p[2]) &&
                  (p[3] === null ||
                    `${dateOnly(row.royalty_date).slice(0, 7)}-01` === p[3]),
              ).length,
            },
          ]),
      },
      {
        match:
          "from kdp_sale_transactions where workspace_id = $1 and ($2::bigint",
        handle: (p) =>
          this.ok(
            t.kdpSaleTransactions
              .filter(
                (row) =>
                  row.workspace_id === p[0] &&
                  (p[1] === null || row.book_id === p[1]) &&
                  (p[2] === null || row.profile_id === p[2]) &&
                  (p[3] === null ||
                    `${dateOnly(row.royalty_date).slice(0, 7)}-01` === p[3]),
              )
              .sort(
                (a, b) =>
                  dateOnly(b.order_date).localeCompare(
                    dateOnly(a.order_date),
                  ) || Number(b.id) - Number(a.id),
              )
              .slice(
                (p[5] as number) ?? 0,
                ((p[5] as number) ?? 0) + (p[4] as number),
              ),
          ),
      },
      {
        // Daily KDP royalty by order date, converted per day (listKdpDailyRoyalty).
        match: "select order_date as metric_date, royalty, currency",
        handle: (p, db) => {
          const start = String(p[1]);
          const end = String(p[2]);
          const display = String(p[4]);
          const byDate = new Map<
            string,
            { royalty: number; missing: boolean }
          >();
          for (const row of t.kdpSaleTransactions) {
            const date = dateOnly(row.order_date);
            if (
              row.workspace_id !== p[0] ||
              date < start ||
              date > end ||
              (p[3] !== null && String(row.book_id) !== String(p[3]))
            ) {
              continue;
            }
            const entry = byDate.get(date) ?? { royalty: 0, missing: false };
            const dr = db.fxRateFor(display, date);
            const nr = db.fxRateFor(String(row.currency), date);
            if (dr === null || nr === null) {
              if (Number(row.royalty) !== 0) entry.missing = true;
            } else {
              entry.royalty += (Number(row.royalty) * dr) / nr;
            }
            byDate.set(date, entry);
          }
          return this.ok(
            [...byDate.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, entry]) => ({
                metric_date: date,
                royalty: entry.royalty.toFixed(4),
                rates_missing: entry.missing,
              })),
          );
        },
      },
      {
        // Ad-attributed copies per linked book × profile × month:
        // fact ad_id → ads.asin → book_profile_links, greatest() convention.
        match: "from advertised_product_metrics_daily m join ads a",
        handle: (p, db) => {
          const totals = new Map<string, number>();
          for (const m of t.advertisedProductMetricsDaily) {
            const ad = t.ads.find(
              (a) =>
                a.profile_id === m.profile_id && a.amazon_ad_id === m.ad_id,
            );
            if (!ad) continue;
            const link = t.bookProfileLinks.find(
              (l) =>
                l.profile_id === m.profile_id &&
                l.marketplace_asin === ad.asin &&
                l.enabled === true,
            );
            if (!link) continue;
            const profile = t.amazonProfiles.find(
              (ap) => ap.id === m.profile_id,
            );
            if (!profile || !db.profileForConnectionWorkspace(p[0], profile)) {
              continue;
            }
            const month = `${dateOnly(m.metric_date).slice(0, 7)}-01`;
            const copies = Math.max(
              Number(m.units_sold_clicks14d ?? 0),
              Number(m.purchases14d ?? 0),
            );
            const key = `${link.book_id} ${link.profile_id} ${month}`;
            totals.set(key, (totals.get(key) ?? 0) + copies);
          }
          const rows = [...totals.entries()]
            .map(([key, adUnits]) => {
              const [book_id, profile_id, month] = key.split(" ") as [
                string,
                string,
                string,
              ];
              return { book_id, profile_id, month, ad_units: String(adUnits) };
            })
            .sort((a, b) => a.month.localeCompare(b.month));
          return this.ok(rows);
        },
      },
      {
        // Fulfillment lag per profile × month, standard-rate rows only.
        match: "percentile_cont",
        handle: (p) => {
          const lagsByKey = new Map<string, number[]>();
          const unitsByKey = new Map<string, number>();
          for (const row of t.kdpSaleTransactions) {
            if (row.workspace_id !== p[0]) continue;
            if (row.profile_id === null) continue;
            if (["40%", "50%"].includes(String(row.royalty_type))) continue;
            if (
              String(row.transaction_type)
                .toLowerCase()
                .startsWith("expanded distribution")
            ) {
              continue;
            }
            const month = `${dateOnly(row.order_date).slice(0, 7)}-01`;
            const lag =
              (Date.parse(dateOnly(row.royalty_date)) -
                Date.parse(dateOnly(row.order_date))) /
              86_400_000;
            const key = `${row.profile_id} ${month}`;
            const lags = lagsByKey.get(key);
            if (lags) {
              lags.push(lag);
            } else {
              lagsByKey.set(key, [lag]);
            }
            unitsByKey.set(
              key,
              (unitsByKey.get(key) ?? 0) + Number(row.net_units),
            );
          }
          const rows = [...lagsByKey.entries()]
            .map(([key, lags]) => {
              const [profile_id, month] = key.split(" ") as [string, string];
              const sorted = [...lags].sort((a, b) => a - b);
              const rank = 0.5 * (sorted.length - 1);
              const lower = Math.floor(rank);
              const median =
                sorted.length % 2 === 1
                  ? sorted[lower]!
                  : (sorted[lower]! + sorted[lower + 1]!) / 2;
              const average =
                sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
              return {
                profile_id,
                month,
                median_days: median,
                average_days: average,
                standard_units: String(unitsByKey.get(key) ?? 0),
              };
            })
            .sort((a, b) => a.month.localeCompare(b.month));
          return this.ok(rows);
        },
      },
      {
        // Full effective-dated economics history of the workspace.
        match: "order by be.book_id, be.profile_id, be.effective_from asc",
        handle: (p) =>
          this.ok(
            t.bookEconomics
              .filter(
                (row) =>
                  t.books.find((b) => b.id === row.book_id)?.workspace_id ===
                  p[0],
              )
              .sort(
                (a, b) =>
                  String(a.book_id).localeCompare(
                    String(b.book_id),
                    undefined,
                    {
                      numeric: true,
                    },
                  ) ||
                  String(a.profile_id).localeCompare(
                    String(b.profile_id),
                    undefined,
                    { numeric: true },
                  ) ||
                  dateOnly(a.effective_from).localeCompare(
                    dateOnly(b.effective_from),
                  ) ||
                  Number(a.id) - Number(b.id),
              )
              .map((row) => ({
                ...row,
                amazon_profile_id:
                  t.amazonProfiles.find((ap) => ap.id === row.profile_id)
                    ?.profile_id ?? null,
              })),
          ),
      },
      {
        match: "insert into book_economics",
        handle: (p) => {
          const existing = t.bookEconomics.find(
            (r) =>
              r.book_id === p[0] &&
              r.profile_id === p[1] &&
              r.effective_from === p[2],
          );
          if (existing) {
            existing.currency = p[3];
            existing.list_price = p[4];
            existing.estimated_royalty_per_sale = p[5];
            existing.target_acos = p[6];
            existing.goal_mode = p[7];
            existing.max_spend_without_sale = p[8];
            existing.max_bid = p[9];
            existing.max_daily_budget = p[10];
            existing.notes = p[11];
            return this.ok([existing]);
          }
          const row = {
            id: nextId(),
            book_id: p[0],
            profile_id: p[1],
            effective_from: p[2],
            currency: p[3],
            list_price: p[4],
            estimated_royalty_per_sale: p[5],
            target_acos: p[6],
            goal_mode: p[7],
            max_spend_without_sale: p[8],
            max_bid: p[9],
            max_daily_budget: p[10],
            notes: p[11],
            created_at: new Date(),
          };
          t.bookEconomics.push(row);
          return this.ok([row]);
        },
      },
      {
        match:
          "select * from book_economics where book_id = $1 and profile_id = $2",
        handle: (p) => {
          const onDate = p[2]
            ? String(p[2])
            : new Date().toISOString().slice(0, 10);
          const row = t.bookEconomics
            .filter(
              (r) =>
                r.book_id === p[0] &&
                r.profile_id === p[1] &&
                String(r.effective_from) <= onDate,
            )
            .sort((a, b) =>
              String(b.effective_from).localeCompare(String(a.effective_from)),
            )[0];
          return this.ok(row ? [row] : []);
        },
      },
      {
        match: "select bpl.book_id, bpl.profile_id, bpl.marketplace_asin",
        handle: (p) =>
          this.ok(
            t.bookProfileLinks
              .filter(
                (l) =>
                  l.enabled === true &&
                  t.books.some(
                    (b) => b.id === l.book_id && b.workspace_id === p[0],
                  ),
              )
              .map((l) => ({
                book_id: l.book_id,
                profile_id: l.profile_id,
                marketplace_asin: l.marketplace_asin,
                title: t.books.find((b) => b.id === l.book_id)?.title,
              })),
          ),
      },

      // -- workspace settings --------------------------------------------------
      {
        match: "select display_currency from workspaces where id = $1",
        handle: (p) =>
          this.ok(
            t.workspaces
              .filter((w) => w.id === p[0])
              .map((w) => ({ display_currency: w.display_currency ?? "USD" })),
          ),
      },
      {
        match: "update workspaces set display_currency = $2 where id = $1",
        handle: (p) => {
          const row = t.workspaces.find((w) => w.id === p[0]);
          if (!row) return { rows: [], rowCount: 0 };
          row.display_currency = p[1];
          return { rows: [{ id: row.id }], rowCount: 1 };
        },
      },

      // -- fx rates and fx_sync health ------------------------------------------
      {
        match: "select max(rate_date)::text as latest from fx_rates",
        handle: () => this.ok([{ latest: this.latestFxRateDate() }]),
      },
      {
        match: "where q.type = 'fx_sync'",
        handle: () => {
          const job = t.jobQueue
            .filter(
              (j) =>
                j.type === "fx_sync" &&
                (["running", "done", "failed", "dead"].includes(
                  String(j.status),
                ) ||
                  (j.status === "pending" && Number(j.attempts ?? 0) > 0)),
            )
            .sort((a, b) => Number(b.id) - Number(a.id))[0];
          return this.ok([
            {
              latest_rate_date: this.latestFxRateDate(),
              last_status: job ? job.status : null,
              last_run_at: job
                ? (job.finished_at ?? job.heartbeat_at ?? job.run_at ?? null)
                : null,
              last_error: job ? (job.last_error ?? null) : null,
            },
          ]);
        },
      },

      // -- converting dashboard queries (country=all / country-spend) -----------
      {
        match: "coalesce(sum(m.impressions), 0)::text as impressions",
        handle: (p, db) => {
          const profileIds = (p[0] as string[]).map(String);
          const start = String(p[1]);
          const end = String(p[2]);
          const display = String(p[4]);
          let impressions = 0;
          let clicks = 0;
          let orders = 0;
          let units = 0;
          let cost = 0;
          let sales = 0;
          let ratesMissing = false;
          for (const fact of t.campaignMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              !profileIds.includes(String(fact.profile_id)) ||
              date < start ||
              date > end
            ) {
              continue;
            }
            impressions += Number(fact.impressions);
            clicks += Number(fact.clicks);
            orders += Number(fact.purchases14d ?? fact.orders);
            units += Number(fact.units_sold_clicks14d ?? fact.units);
            const dr = db.fxRateFor(display, date);
            const nr = db.fxRateFor(String(fact.currency), date);
            if (dr === null || nr === null) {
              if (Number(fact.cost) !== 0 || Number(fact.sales) !== 0) {
                ratesMissing = true;
              }
              continue;
            }
            cost += (Number(fact.cost) * dr) / nr;
            sales += (Number(fact.sales14d ?? fact.sales) * dr) / nr;
          }
          return this.ok([
            {
              impressions: String(impressions),
              clicks: String(clicks),
              cost: cost.toFixed(4),
              sales: sales.toFixed(4),
              orders: String(orders),
              units: String(units),
              rates_missing: ratesMissing,
            },
          ]);
        },
      },
      {
        match: "round(sum(m.cost * dr.rate / nr.rate), 4)::text as cost",
        handle: (p, db) => {
          const profileIds = (p[0] as string[]).map(String);
          const start = String(p[1]);
          const end = String(p[2]);
          const display = String(p[4]);
          const byDate = new Map<
            string,
            { cost: number; sales: number; orders: number; missing: boolean }
          >();
          for (const fact of t.campaignMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              !profileIds.includes(String(fact.profile_id)) ||
              date < start ||
              date > end
            ) {
              continue;
            }
            const entry = byDate.get(date) ?? {
              cost: 0,
              sales: 0,
              orders: 0,
              missing: false,
            };
            entry.orders += Number(fact.purchases14d ?? fact.orders);
            const dr = db.fxRateFor(display, date);
            const nr = db.fxRateFor(String(fact.currency), date);
            if (dr === null || nr === null) {
              if (Number(fact.cost) !== 0 || Number(fact.sales) !== 0) {
                entry.missing = true;
              }
            } else {
              entry.cost += (Number(fact.cost) * dr) / nr;
              entry.sales += (Number(fact.sales14d ?? fact.sales) * dr) / nr;
            }
            byDate.set(date, entry);
          }
          return this.ok(
            [...byDate.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, entry]) => ({
                metric_date: date,
                cost: entry.cost.toFixed(4),
                sales: entry.sales.toFixed(4),
                orders: String(entry.orders),
                rates_missing: entry.missing,
              })),
          );
        },
      },
      {
        match: "rates_missing from advertised_product_metrics_daily m",
        handle: (p, db) => {
          const profileIds = (p[0] as string[]).map(String);
          const start = String(p[1]);
          const end = String(p[2]);
          const display = String(p[4]);
          const byDate = new Map<
            string,
            { missing: boolean; royalty: number; ratesMissing: boolean }
          >();
          for (const fact of t.advertisedProductMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              !profileIds.includes(String(fact.profile_id)) ||
              date < start ||
              date > end
            ) {
              continue;
            }
            const ad = t.ads.find(
              (a) =>
                a.profile_id === fact.profile_id &&
                a.amazon_ad_id === fact.ad_id,
            );
            const link = ad
              ? t.bookProfileLinks.find(
                  (l) =>
                    l.profile_id === fact.profile_id &&
                    l.marketplace_asin === ad.asin &&
                    l.enabled === true,
                )
              : undefined;
            const economics = link
              ? t.bookEconomics
                  .filter(
                    (be) =>
                      be.book_id === link.book_id &&
                      be.profile_id === link.profile_id &&
                      be.currency === fact.currency &&
                      String(be.effective_from) <= date,
                  )
                  .sort(
                    (a, b) =>
                      String(b.effective_from).localeCompare(
                        String(a.effective_from),
                      ) || Number(b.id) - Number(a.id),
                  )[0]
              : undefined;
            const copies = Math.max(
              Number(fact.units_sold_clicks14d ?? fact.units),
              Number(fact.purchases14d ?? fact.orders),
            );
            const entry = byDate.get(date) ?? {
              missing: false,
              royalty: 0,
              ratesMissing: false,
            };
            if (Number(fact.purchases14d ?? fact.orders) > 0 && !economics)
              entry.missing = true;
            const dr = db.fxRateFor(display, date);
            const nr = db.fxRateFor(String(fact.currency), date);
            if (dr === null || nr === null) {
              if (copies > 0 && economics) entry.ratesMissing = true;
            } else if (economics) {
              entry.royalty +=
                (copies * Number(economics.estimated_royalty_per_sale) * dr) /
                nr;
            }
            byDate.set(date, entry);
          }
          return this.ok(
            [...byDate.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, entry]) => ({
                metric_date: date,
                economics_missing: entry.missing,
                estimated_royalty: entry.missing
                  ? null
                  : entry.royalty.toFixed(4),
                rates_missing: entry.ratesMissing,
              })),
          );
        },
      },
      {
        match: "as converted_spend",
        handle: (p, db) => {
          const profileIds = (p[0] as string[]).map(String);
          const start = String(p[1]);
          const end = String(p[2]);
          const display = String(p[4]);
          const byCountry = new Map<
            string,
            { spend: number; missing: boolean }
          >();
          for (const fact of t.campaignMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              !profileIds.includes(String(fact.profile_id)) ||
              date < start ||
              date > end
            ) {
              continue;
            }
            const profile = t.amazonProfiles.find(
              (ap) => ap.id === fact.profile_id,
            );
            if (!profile) continue;
            const country = String(profile.country_code);
            const entry = byCountry.get(country) ?? {
              spend: 0,
              missing: false,
            };
            const dr = db.fxRateFor(display, date);
            const nr = db.fxRateFor(String(fact.currency), date);
            if (dr === null || nr === null) {
              if (Number(fact.cost) !== 0) entry.missing = true;
            } else {
              entry.spend += (Number(fact.cost) * dr) / nr;
            }
            byCountry.set(country, entry);
          }
          return this.ok(
            [...byCountry.entries()].map(([country, entry]) => ({
              country_code: country,
              converted_spend: entry.spend.toFixed(4),
              rates_missing: entry.missing,
            })),
          );
        },
      },

      // -- spend explorer series (breakdown + tree, native and converted) -------
      {
        // repositories/spend.ts, grain=market: groups campaign facts by the
        // profile's country per day. Handles the native and converted (FX
        // cross-rate through the USD pivot) variants — the converted SQL
        // carries the dr/nr rate expression and a fourth display param.
        match: "null::text as parent_id",
        handle: (p, db, text) => {
          const profileIds = (p[0] as string[]).map(String);
          const start = String(p[1]);
          const end = String(p[2]);
          const converted = text.includes("dr.rate / nr.rate");
          const display = converted ? String(p[3]) : null;
          const groups = new Map<string, FakeRow>();
          for (const fact of t.campaignMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              !profileIds.includes(String(fact.profile_id)) ||
              date < start ||
              date > end
            ) {
              continue;
            }
            const profile = t.amazonProfiles.find(
              (ap) => ap.id === fact.profile_id,
            );
            if (!profile) continue;
            const country = String(profile.country_code);
            const currency = String(fact.currency);
            const key = `${country}|${date}|${currency}`;
            const row = groups.get(key) ?? {
              entity_id: country,
              entity_name: country,
              parent_id: null,
              metric_date: date,
              spend: 0,
              sales: 0,
              orders: 0,
              currency,
              rates_missing: false,
            };
            db.accumulateSpendFact(row, fact, converted, display);
            groups.set(key, row);
          }
          return this.ok(db.finalizeSpendRows(groups));
        },
      },
      {
        // repositories/spend.ts, grain=campaign: facts per campaign per day,
        // name from the synced campaigns table, market as parent.
        match: "coalesce(max(c.name), m.campaign_id)",
        handle: (p, db, text) => {
          const profileIds = (p[0] as string[]).map(String);
          const start = String(p[1]);
          const end = String(p[2]);
          const converted = text.includes("dr.rate / nr.rate");
          const display = converted ? String(p[3]) : null;
          const groups = new Map<string, FakeRow>();
          for (const fact of t.campaignMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              !profileIds.includes(String(fact.profile_id)) ||
              date < start ||
              date > end
            ) {
              continue;
            }
            const profile = t.amazonProfiles.find(
              (ap) => ap.id === fact.profile_id,
            );
            if (!profile) continue;
            const campaignId = String(fact.campaign_id);
            const campaign = t.campaigns.find(
              (c) =>
                c.profile_id === fact.profile_id &&
                c.amazon_campaign_id === campaignId,
            );
            const currency = String(fact.currency);
            const key = `${campaignId}|${date}|${currency}`;
            const row = groups.get(key) ?? {
              entity_id: campaignId,
              entity_name: campaign ? String(campaign.name) : campaignId,
              parent_id: String(profile.country_code),
              metric_date: date,
              spend: 0,
              sales: 0,
              orders: 0,
              currency,
              rates_missing: false,
            };
            db.accumulateSpendFact(row, fact, converted, display);
            groups.set(key, row);
          }
          return this.ok(db.finalizeSpendRows(groups));
        },
      },
      {
        // repositories/spend.ts, grain=searchTerm: facts per term per
        // campaign per day (the campaign stays the parent for the treemap).
        match: "m.search_term as entity_id",
        handle: (p, db, text) => {
          const profileIds = (p[0] as string[]).map(String);
          const start = String(p[1]);
          const end = String(p[2]);
          const converted = text.includes("dr.rate / nr.rate");
          const display = converted ? String(p[3]) : null;
          const groups = new Map<string, FakeRow>();
          for (const fact of t.searchTermMetricsDaily) {
            const date = String(fact.metric_date);
            if (
              !profileIds.includes(String(fact.profile_id)) ||
              date < start ||
              date > end
            ) {
              continue;
            }
            const term = String(fact.search_term);
            const campaignId = String(fact.campaign_id);
            const currency = String(fact.currency);
            const key = `${term}|${campaignId}|${date}|${currency}`;
            const row = groups.get(key) ?? {
              entity_id: term,
              entity_name: term,
              parent_id: campaignId,
              metric_date: date,
              spend: 0,
              sales: 0,
              orders: 0,
              currency,
              rates_missing: false,
            };
            db.accumulateSpendFact(row, fact, converted, display);
            groups.set(key, row);
          }
          return this.ok(db.finalizeSpendRows(groups));
        },
      },

      // -- data freshness ---------------------------------------------------------
      {
        match: "cross join (values ('structure'), ('metrics'))",
        handle: (p, db) => {
          const rows: FakeRow[] = [];
          for (const profile of t.amazonProfiles.filter((r) =>
            db.profileForConnectionWorkspace(p[0], r),
          )) {
            for (const dataset of ["structure", "metrics"]) {
              const lastRun = t.syncRuns
                .filter(
                  (r) =>
                    r.profile_id === profile.id &&
                    r.kind === dataset &&
                    r.status === "complete" &&
                    r.finished_at,
                )
                .sort(
                  (a, b) =>
                    new Date(String(b.finished_at)).getTime() -
                    new Date(String(a.finished_at)).getTime(),
                )[0];
              const metricDates = t.campaignMetricsDaily
                .filter((m) => m.profile_id === profile.id)
                .map((m) => String(m.metric_date))
                .sort();
              rows.push({
                profile_pk: profile.id,
                amazon_profile_id: profile.profile_id,
                country_code: profile.country_code,
                dataset,
                last_success_at: lastRun ? lastRun.finished_at : null,
                complete_through:
                  dataset === "metrics" ? (metricDates.at(-1) ?? null) : null,
                has_campaigns: t.campaigns.some(
                  (c) => c.profile_id === profile.id,
                ),
              });
            }
          }
          return this.ok(rows);
        },
      },
    ];
  }
}
