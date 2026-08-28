import type {
  AmazonProfile,
  AdvertisedBookCandidate,
  AuditEvent,
  Book,
  BookCoverInput,
  BookEconomicsInput,
  BookMappingInput,
  BookProfileLinkInput,
  CampaignDetail,
  CampaignListRow,
  CannibalizationResolutionContext,
  ConversionResolutionContext,
  ChangeSet,
  CountrySpend,
  DashboardSummary,
  DataFreshnessResponse,
  FxSyncResult,
  KdpRoyaltyApplyInput,
  KdpRoyaltyApplyResult,
  KdpRoyaltyImport,
  KdpRoyaltyImportInput,
  KdpRoyaltyImportSummary,
  MetricWindow,
  ProfileUpdate,
  Recommendation,
  RecommendationState,
  RecommendationType,
  SearchTermDetail,
  SearchTermExclusionList,
  SearchTermListRow,
  NegativeDetail,
  NegativeKind,
  NegativeListRow,
  SyncRun,
  SyncRunSummary,
  WorkspaceSettings,
  WorkspaceSettingsUpdate,
} from "@amazon-king/contracts";

/**
 * Read-side service interfaces shared by the HTTP API (apps/api) and the MCP
 * server (apps/mcp). Both fronts delegate to the same implementation so their
 * answers cannot drift.
 */

/** Subset of the API config the read service needs. */
export interface ReadServiceConfig {
  /** Global kill switch: reported in sync/status payloads (§10). */
  killSwitch: boolean;
}

/**
 * Minimal structural logger — satisfied by pino and FastifyBaseLogger.
 * The read service currently never logs, but the dependency is kept so
 * callers wire their logger consistently.
 */
export interface ReadServiceLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

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
  listNegatives(
    workspaceId: string,
    days: MetricWindow,
    bookIds?: string[] | null,
    countryCode?: string | null,
    kind?: NegativeKind | null,
  ): Promise<NegativeListRow[]>;
  getNegativeDetail(
    workspaceId: string,
    kind: NegativeKind,
    value: string,
    days: MetricWindow,
    bookIds?: string[] | null,
    countryCode?: string | null,
  ): Promise<NegativeDetail | null>;
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
  /**
   * Import a parsed KDP Royalties Estimator workbook and derive royalty
   * suggestions. Idempotent per file content: a repeat upload returns the
   * existing batch with `alreadyExisted: true`.
   */
  createKdpRoyaltyImport(
    auth: AuthContext,
    input: KdpRoyaltyImportInput,
    meta: RequestMeta,
  ): Promise<KdpRoyaltyImport>;
  /** Recent KDP royalty import batches, newest first. */
  listKdpRoyaltyImports(
    workspaceId: string,
  ): Promise<KdpRoyaltyImportSummary[]>;
  /**
   * Apply selected suggestions into effective-dated economics. One-way:
   * an applied batch cannot be applied again.
   */
  applyKdpRoyaltyImport(
    auth: AuthContext,
    importId: string,
    input: KdpRoyaltyApplyInput,
    meta: RequestMeta,
  ): Promise<KdpRoyaltyApplyResult>;
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
  /** The workspace's persistent search-term exclusion list, alphabetically. */
  listSearchTermExclusions(
    workspaceId: string,
  ): Promise<SearchTermExclusionList>;
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
