import type {
  AmazonConnectionStatus,
  AmazonProfile,
  AuditEvent,
  Book,
  BookEconomicsInput,
  CampaignDetail,
  CampaignRow,
  ChangeAction,
  ChangeSet,
  DashboardSummary,
  DataFreshness,
  ProfileUpdate,
  Recommendation,
  RecommendationState,
  RecommendationType,
  SyncRun,
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
}

export interface SessionService {
  /**
   * Begin passwordless login: create a single-use login token and deliver the
   * magic link (dev: logged, never returned to the client). No-ops silently
   * when the email is not allowed (OWNER_EMAIL restriction) to avoid
   * account enumeration.
   */
  startLogin(email: string, meta: RequestMeta): Promise<void>;
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
  getSyncRun(workspaceId: string, syncRunId: string): Promise<SyncRun | null>;
  dashboardSummary(
    workspaceId: string,
    days: number,
  ): Promise<DashboardSummary>;
  listCampaigns(workspaceId: string, days: number): Promise<CampaignRow[]>;
  getCampaignDetail(
    workspaceId: string,
    amazonCampaignId: string,
    days: number,
  ): Promise<CampaignDetail | null>;
  listBooks(workspaceId: string): Promise<Book[]>;
  saveBookEconomics(
    auth: AuthContext,
    bookId: string,
    input: BookEconomicsInput,
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
  rejectRecommendation(
    auth: AuthContext,
    recommendationId: string,
    meta: RequestMeta,
  ): Promise<Recommendation | null>;
  listChangeSets(workspaceId: string): Promise<ChangeSet[]>;
  listAuditEvents(workspaceId: string): Promise<AuditEvent[]>;
  dataFreshness(workspaceId: string): Promise<DataFreshness[]>;
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
  /**
   * Create an immutable change set from recommendation ids. Fingerprinted:
   * replaying the same ids returns the existing set (double-click safe).
   */
  createChangeSet(
    auth: AuthContext,
    recommendationIds: string[],
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
  /** Fresh guardrail evaluation; moves draft → previewed (plan §10). */
  previewChangeSet(
    auth: AuthContext,
    changeSetId: string,
    meta: RequestMeta,
  ): Promise<ChangeSetPreviewResult>;
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
