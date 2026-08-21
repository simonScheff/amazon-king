import type {
  AmazonConnectionStatus,
  AmazonProfile,
  AdvertisedBookCandidate,
  AuditEvent,
  Book,
  BookCoverInput,
  BookEconomicsInput,
  BookMappingInput,
  BookProfileLinkInput,
  CampaignCreationCreate,
  CampaignCreationResult,
  CampaignDetail,
  CampaignListRow,
  CampaignMaxCpc,
  CannibalizationResolutionContext,
  ConversionResolutionContext,
  ChangeAction,
  ChangeSet,
  ChangeSetStatus,
  CountrySpend,
  MaxCpcChangeSetResult,
  DashboardSummary,
  DataFreshnessResponse,
  FxSyncResult,
  MetricWindow,
  ProfileUpdate,
  Recommendation,
  RecommendationState,
  RecommendationType,
  SearchTermDetail,
  SearchTermListRow,
  SyncRun,
  SyncRunSummary,
  WorkspaceSettings,
  WorkspaceSettingsUpdate,
} from "@amazon-king/contracts";

/**
 * Injectable service interfaces (plan §14 test strategy). Route handlers are
 * thin wrappers over these; tests substitute in-memory fakes. Production
 * implementations live in src/services/* and are wired in src/index.ts.
 */

/** Authenticated request context resolved from the session cookie. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  workspaceId: string;
  email: string;
  /** SHA-256 hex of the opaque session token (basis of the CSRF token). */
  sessionTokenHash: string;
  /** When the session was created (recent-auth checks, plan §13). */
  sessionCreatedAt: Date;
  expiresAt: Date;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface VerifiedLogin {
  /** Opaque session token for the cookie (never stored raw server-side). */
  sessionToken: string;
  auth: AuthContext;
  /** Allowlisted web origin to redirect to after verify. */
  webOrigin: string;
  /** Same-origin path within webOrigin to land on after verify, if requested. */
  nextPath: string | null;
}

export interface LoginStartResult {
  /** Development-only single-use URL when SMTP delivery is not configured. */
  devLoginUrl?: string;
}

export interface SessionService {
  /**
   * Begin passwordless login: create a single-use login token and deliver the
   * magic link. Local development without SMTP returns the link to the local
   * browser; production delivers it by email. No-ops silently when the email
   * is not allowed (OWNER_EMAIL restriction) to avoid account enumeration.
   */
  startLogin(
    email: string,
    meta: RequestMeta,
    /** Browser Origin header of the login request; used for the magic-link base and post-verify redirect when allowlisted. */
    origin?: string,
    /** Same-origin path to land on after verify (re-auth flow); relative paths only. */
    next?: string,
  ): Promise<LoginStartResult>;
  /**
   * Consume a login token (single use), provision user/workspace on first
   * login, and create a session. Null when the token is bad/expired/used.
   */
  verifyLogin(token: string, meta: RequestMeta): Promise<VerifiedLogin | null>;
  /** Resolve a live session from its cookie token; extends expiry (rolling). */
  authenticate(sessionToken: string | undefined): Promise<AuthContext | null>;
  logout(auth: AuthContext, meta: RequestMeta): Promise<void>;
  /** Stateless per-session CSRF token (HMAC of the session token hash). */
  csrfTokenFor(auth: AuthContext): string;
  /** Constant-time check of the x-csrf-token header against the session. */
  verifyCsrf(auth: AuthContext, headerToken: string | undefined): boolean;
  /** True when the session was created within the recent-auth window (§13). */
  isRecentAuth(auth: AuthContext, now?: Date): boolean;
}

export interface AmazonStartResult {
  url: string;
}

export interface AmazonCallbackResult {
  /** Absolute URL (WEB_ORIGIN-based allowlist) to redirect the browser to. */
  redirectTo: string;
}

export interface AmazonService {
  /** Build the LWA consent URL and persist only the state hash (Login B §5). */
  start(auth: AuthContext, meta: RequestMeta): Promise<AmazonStartResult>;
  /**
   * Handle the OAuth callback. Always resolves to a redirect target inside
   * WEB_ORIGIN — failures are reported as `?error=<code>` on /connect.
   */
  handleCallback(
    params: { state?: string; code?: string },
    auth: AuthContext | null,
    meta: RequestMeta,
  ): Promise<AmazonCallbackResult>;
  status(workspaceId: string): Promise<AmazonConnectionStatus>;
  disconnect(auth: AuthContext, meta: RequestMeta): Promise<void>;
}

export interface RecommendationFilter {
  type?: RecommendationType;
  state?: RecommendationState;
  /**
   * Global product filter: external book ids from the API. Undefined/empty =
   * no filter. The service resolves each id to a workspace-owned internal PK
   * (404 on an unknown or foreign book).
   */
  bookIds?: string[];
}

export interface ReadService {
  listProfiles(workspaceId: string): Promise<AmazonProfile[]>;
  updateProfile(
    auth: AuthContext,
    amazonProfileId: string,
    patch: ProfileUpdate,
    meta: RequestMeta,
  ): Promise<AmazonProfile>;
  /** Enqueue structure_sync + metrics_sync jobs; never syncs in-request. */
  requestSync(
    auth: AuthContext,
    amazonProfileId: string,
    meta: RequestMeta,
  ): Promise<SyncRun>;
  /**
   * Enqueue one fx_sync job (deduped against a pending/running one) and
   * return the current FX status. A read-only upstream fetch: no sync_runs
   * row (that table is per-profile) and no recent-auth gate.
   */
  requestFxSync(auth: AuthContext, meta: RequestMeta): Promise<FxSyncResult>;
  getSyncRun(workspaceId: string, syncRunId: string): Promise<SyncRun | null>;
  /** Recent sync runs of the workspace with per-report progress, newest first. */
  listSyncRuns(workspaceId: string): Promise<SyncRunSummary[]>;
  /**
   * Overview KPIs and trend. `countryCode` is a two-letter market or `"all"`
   * (docs/fx-rates-all-market-plan.md §4): with `"all"` every marketplace is
   * converted per fact date into `currency` (default: the workspace's
   * display currency). `currency` is ignored for a specific country.
   */
  dashboardSummary(
    workspaceId: string,
    days: MetricWindow,
    countryCode: string,
    bookIds?: string[],
    currency?: string,
  ): Promise<DashboardSummary>;
  /**
   * Spend per marketplace. When `currency` is present, each row also carries
   * a converted total in that currency (null when rates do not cover it).
   */
  dashboardCountrySpend(
    workspaceId: string,
    days: MetricWindow,
    bookIds?: string[],
    currency?: string,
  ): Promise<CountrySpend>;
  listCampaigns(
    workspaceId: string,
    days: MetricWindow,
    bookIds?: string[],
  ): Promise<CampaignListRow[]>;
  getCampaignDetail(
    workspaceId: string,
    amazonCampaignId: string,
    days: MetricWindow,
    bookIds?: string[],
  ): Promise<CampaignDetail | null>;
  listSearchTerms(
    workspaceId: string,
    days: MetricWindow,
    bookIds?: string[] | null,
    countryCode?: string | null,
  ): Promise<SearchTermListRow[]>;
  getSearchTermDetail(
    workspaceId: string,
    searchTerm: string,
    days: MetricWindow,
    bookIds?: string[] | null,
    countryCode?: string | null,
  ): Promise<SearchTermDetail | null>;
  listBooks(workspaceId: string): Promise<Book[]>;
  listUnmappedAdvertisedProducts(
    workspaceId: string,
  ): Promise<AdvertisedBookCandidate[]>;
  mapAdvertisedProduct(
    auth: AuthContext,
    input: BookMappingInput,
    meta: RequestMeta,
  ): Promise<Book>;
  linkBookToMarkets(
    auth: AuthContext,
    bookId: string,
    input: BookProfileLinkInput,
    meta: RequestMeta,
  ): Promise<Book>;
  saveBookEconomics(
    auth: AuthContext,
    bookId: string,
    input: BookEconomicsInput,
    meta: RequestMeta,
  ): Promise<void>;
  saveBookCover(
    auth: AuthContext,
    bookId: string,
    input: BookCoverInput,
    meta: RequestMeta,
  ): Promise<void>;
  listRecommendations(
    workspaceId: string,
    filter: RecommendationFilter,
  ): Promise<Recommendation[]>;
  getRecommendation(
    workspaceId: string,
    recommendationId: string,
  ): Promise<Recommendation | null>;
  getCannibalizationResolutionContext(
    workspaceId: string,
    recommendationId: string,
  ): Promise<CannibalizationResolutionContext | null>;
  /** Campaign, book, and shopper-term context for one conversion finding. */
  getConversionResolutionContext(
    workspaceId: string,
    recommendationId: string,
  ): Promise<ConversionResolutionContext | null>;
  rejectRecommendation(
    auth: AuthContext,
    recommendationId: string,
    meta: RequestMeta,
    /** `snoozeDays` shortens the default dismissal suppression window. */
    options?: { snoozeDays?: number },
  ): Promise<Recommendation | null>;
  listChangeSets(workspaceId: string): Promise<ChangeSet[]>;
  listAuditEvents(workspaceId: string): Promise<AuditEvent[]>;
  /** Per-profile freshness plus the workspace-level FX sync health. */
  dataFreshness(workspaceId: string): Promise<DataFreshnessResponse>;
  /**
   * Update workspace settings (currently only the display currency of the
   * all-market view). A local display setting: CSRF + WRITE rate limit at the
   * route, no recent-auth gate — it changes no spend and no stored facts.
   */
  updateWorkspaceSettings(
    auth: AuthContext,
    patch: WorkspaceSettingsUpdate,
    meta: RequestMeta,
  ): Promise<WorkspaceSettings>;
}

export interface ChangeSetWithActions {
  changeSet: ChangeSet;
  actions: ChangeAction[];
}

export interface ChangeSetPreviewResult extends ChangeSetWithActions {
  /** Guardrail violation messages from a fresh evaluation (empty = clean). */
  guardrails: string[];
}

export interface ChangeService {
  /** Fresh Amazon-side view of every control that can raise CPC. */
  getCampaignMaxCpc(
    workspaceId: string,
    amazonCampaignId: string,
  ): Promise<CampaignMaxCpc>;
  /** Create an immutable guarded draft that enforces one campaign CPC ceiling. */
  setCampaignMaxCpc(
    auth: AuthContext,
    amazonCampaignId: string,
    maxCpc: string,
    meta: RequestMeta,
  ): Promise<MaxCpcChangeSetResult>;
  /**
   * One-click campaign attribute update (pause/enable or rename): drafts an
   * immutable `campaign_update` change set and immediately runs the guarded
   * apply. Exactly one of state/name is set (the routes guarantee it).
   * Fingerprinted: re-submitting the identical update replays the same set.
   */
  updateCampaign(
    auth: AuthContext,
    amazonCampaignId: string,
    update: { state?: "enabled" | "paused"; name?: string },
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
  /**
   * Create an immutable change set from recommendation ids. Fingerprinted:
   * replaying the same ids returns the existing set (double-click safe).
   */
  createChangeSet(
    auth: AuthContext,
    recommendationIds: string[],
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
  /**
   * Block shopper terms in one campaign: a draft change set adding a
   * campaign-level negative exact per term (a negative ASIN target for ASIN
   * terms). Fingerprinted, so re-submitting the same terms replays the set.
   */
  createCampaignNegativesChangeSet(
    auth: AuthContext,
    amazonCampaignId: string,
    searchTerms: string[],
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
  /** Route one conflicted shopper term with campaign-level negative exacts. */
  createCannibalizationChangeSet(
    auth: AuthContext,
    recommendationId: string,
    destinationCampaignId: string,
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
  /**
   * Create one guarded `campaign_creation` change set per requested profile
   * (campaign + ad group + product ad + keywords). Fingerprinted per profile:
   * re-submitting the identical spec replays the existing sets.
   */
  createCampaignCreationChangeSets(
    auth: AuthContext,
    input: CampaignCreationCreate,
    meta: RequestMeta,
  ): Promise<CampaignCreationResult>;
  /** Fresh guardrail evaluation; moves draft → previewed (plan §10). */
  previewChangeSet(
    auth: AuthContext,
    changeSetId: string,
    meta: RequestMeta,
  ): Promise<ChangeSetPreviewResult>;
  /**
   * Workspace-scoped status of a change set. Used by the apply route to
   * decide whether recent re-authentication is required: retrying a `failed`
   * set replays an already-approved payload through the same guarded path, so
   * it is exempt; first-time applies are not.
   */
  getChangeSetStatus(
    auth: AuthContext,
    changeSetId: string,
  ): Promise<ChangeSetStatus>;
  /**
   * Guarded apply (§10): status lock, expiry check, Amazon re-read +
   * before-state compare, guardrail re-check, per-item results, verify.
   * Re-applying a finished set returns the stored result without another
   * Amazon call.
   */
  applyChangeSet(
    auth: AuthContext,
    changeSetId: string,
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
  /** Compensating action using the saved before value (§10 rollback). */
  rollbackAction(
    auth: AuthContext,
    changeActionId: string,
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
}

export interface ApiServices {
  session: SessionService;
  amazon: AmazonService;
  read: ReadService;
  changes: ChangeService;
}
