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
  changeSets: FakeRow[];
  changeActions: FakeRow[];
  campaignBidPolicies: FakeRow[];
  syncRuns: FakeRow[];
  jobQueue: FakeRow[];
  auditEvents: FakeRow[];
  books: FakeRow[];
  bookProfileLinks: FakeRow[];
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
    changeSets: [],
    changeActions: [],
    campaignBidPolicies: [],
    syncRuns: [],
    jobQueue: [],
    auditEvents: [],
    books: [],
    bookProfileLinks: [],
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
          return { rows: [{ email: row.email }], rowCount: 1 };
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
            .map((r): FakeRow => ({
              ...r,
              amazon_profile_id: t.amazonProfiles.find(
                (ap) => ap.id === r.profile_id,
              )!.profile_id,
            }));
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
        match: "select * from change_actions where change_set_id = $1",
        handle: (p) =>
          this.ok(t.changeActions.filter((r) => r.change_set_id === p[0])),
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
        match: "select ca.action_type, ca.target_id::text",
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
                target_id: a.target_id,
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
        match: "from ad_groups where id = $1",
        handle: (p) => this.ok(t.adGroups.filter((r) => r.id === p[0])),
      },
      {
        match: "from targets where id = $1",
        handle: (p) => this.ok(t.targets.filter((r) => r.id === p[0])),
      },

      // -- books -----------------------------------------------------------------
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
    ];
  }
}
