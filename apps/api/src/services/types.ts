import type {
  AmazonConnectionStatus,
  CampaignCreationCreate,
  CampaignCreationResult,
  CampaignMaxCpc,
  ChangeAction,
  ChangeSet,
  ChangeSetStatus,
  MaxCpcChangeSetResult,
  NegativeRemovalCreate,
  SearchTermDetail,
  SearchTermNegativesResult,
} from "@amazon-king/contracts";
import type {
  AuthContext,
  ReadService,
  RequestMeta,
} from "@amazon-king/read-service";

/**
 * Injectable service interfaces (plan §14 test strategy). Route handlers are
 * thin wrappers over these; tests substitute in-memory fakes. Production
 * implementations live in src/services/* and are wired in src/index.ts.
 *
 * The read-side interfaces (AuthContext, RequestMeta, ReadService, …) live in
 * @amazon-king/read-service, shared with the MCP server (apps/mcp).
 */

export type {
  AuthContext,
  ReadService,
  RecommendationFilter,
  RequestMeta,
} from "@amazon-king/read-service";

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
  /**
   * Re-include a shopper term or product by removing a synced negative: a
   * draft change set with one `remove_negative_exact` /
   * `remove_negative_target` action built from the mirror row. Fingerprinted,
   * so re-submitting the same removal replays the set.
   */
  createNegativeRemovalChangeSet(
    auth: AuthContext,
    amazonCampaignId: string,
    input: NegativeRemovalCreate,
    meta: RequestMeta,
  ): Promise<ChangeSetWithActions>;
  /**
   * Block one shopper term in many campaigns at once ("Exclude everywhere"
   * on the search-term detail): one draft negatives change set per requested
   * Amazon campaign id that appears in the already-resolved detail rows with
   * state "enabled". Unknown or non-enabled ids are reported as skipped,
   * never an error. Fingerprinted per campaign, so a repeat replays the sets.
   */
  createSearchTermNegativesChangeSets(
    auth: AuthContext,
    detail: SearchTermDetail,
    campaignIds: string[],
    meta: RequestMeta,
  ): Promise<SearchTermNegativesResult>;
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
