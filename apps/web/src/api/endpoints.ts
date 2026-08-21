import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { z } from "zod";
import {
  amazonConnectionStatusSchema,
  amazonProfileSchema,
  advertisedBookCandidateSchema,
  auditEventSchema,
  bookSchema,
  campaignCreationResultSchema,
  campaignDetailSchema,
  campaignListRowSchema,
  campaignMaxCpcSchema,
  campaignUpdateResultSchema,
  cannibalizationResolutionContextSchema,
  changeActionSchema,
  changeSetSchema,
  conversionResolutionContextSchema,
  countrySpendSchema,
  dashboardSummarySchema,
  dataFreshnessSchema,
  maxCpcChangeSetResultSchema,
  recommendationSchema,
  searchTermDetailSchema,
  searchTermListRowSchema,
  sessionInfoSchema,
  syncRunSchema,
  syncRunSummarySchema,
  type Book,
  type BookMappingInput,
  type BookEconomicsInput,
  type BookCoverInput,
  type BookProfileLinkInput,
  type CampaignCreationCreate,
  type CampaignNegativesCreate,
  type ChangeSetCreate,
  type LoginRequest,
  type MetricWindow,
  type ProfileUpdate,
  type RecommendationState,
  type RecommendationType,
  type RejectRecommendation,
} from "@amazon-king/contracts";
import { ApiError, apiFetch, redeemLoginToken, setCsrfToken } from "./client";
import { parseLoginToken } from "../lib/login-link";

// ---------------------------------------------------------------------------
// Response schemas. Where the contracts package does not yet define a shape
// for an endpoint, a local schema is defined here (see API-GAPS notes).
// ---------------------------------------------------------------------------

// API-GAP: SessionInfo in contracts has no csrfToken field, but the browser
// needs one to send x-csrf-token on mutations.
const sessionResponseSchema = sessionInfoSchema.extend({
  csrfToken: z.string(),
});

const loginResponseSchema = z.object({
  ok: z.literal(true),
  devLoginUrl: z.url().optional(),
});

export const dashboardSummaryResponseSchema = dashboardSummarySchema;
export type DashboardSummaryResponse = z.infer<
  typeof dashboardSummaryResponseSchema
>;

const amazonStartResponseSchema = z.object({ url: z.string() });
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;

// API-GAP: no contract for GET /api/change-sets/:id/preview.
export const changeSetPreviewSchema = z.object({
  changeSet: changeSetSchema,
  actions: z.array(changeActionSchema),
  guardrails: z.array(z.string()).default([]),
});
export type ChangeSetPreview = z.infer<typeof changeSetPreviewSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const session = await apiFetch("/api/session", {
        schema: sessionResponseSchema,
      });
      setCsrfToken(session.csrfToken);
      return session;
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: (body: LoginRequest) =>
      apiFetch("/api/session/login", {
        method: "POST",
        body,
        schema: loginResponseSchema,
      }),
  });
}

/**
 * Signs in from a pasted sign-in link. The link's own session lives in the
 * browser that opened it, so the installed app redeems the token itself and
 * then reads the session it just established.
 */
export function useRedeemLoginLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pasted: string) => {
      const token = parseLoginToken(pasted);
      if (!token) {
        throw new ApiError(
          400,
          "That is not a sign-in link. Paste the whole link from the email.",
          "INVALID_LINK",
        );
      }
      await redeemLoginToken(token);
      const session = await apiFetch("/api/session", {
        schema: sessionResponseSchema,
      });
      setCsrfToken(session.csrfToken);
      return session;
    },
    onSuccess: (session) => {
      qc.setQueryData(["session"], session);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await apiFetch("/api/session/logout", { method: "POST" });
      } catch (error) {
        // An expired session is already signed out. A stale CSRF token can
        // happen in a long-open tab; refresh it once from the live session and
        // retry instead of trapping the user in the authenticated layout.
        if (error instanceof ApiError && error.status === 401) return;
        if (!(error instanceof ApiError) || error.status !== 403) throw error;

        const session = await apiFetch("/api/session", {
          schema: sessionResponseSchema,
        });
        setCsrfToken(session.csrfToken);
        await apiFetch("/api/session/logout", { method: "POST" });
      }
    },
    onSuccess: () => {
      setCsrfToken(null);
      // Remove only the stale authenticated session. Clearing or refetching
      // from inside this mutation can dispose the observer or race navigation.
      qc.removeQueries({ queryKey: ["session"], exact: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Amazon connection and profiles
// ---------------------------------------------------------------------------

export function useAmazonStatus() {
  return useQuery({
    queryKey: ["amazon-status"],
    queryFn: () =>
      apiFetch("/api/integrations/amazon/status", {
        schema: amazonConnectionStatusSchema,
      }),
  });
}

export function useAmazonStart() {
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/integrations/amazon/start", {
        method: "POST",
        schema: amazonStartResponseSchema,
      }),
  });
}

export function useAmazonDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/integrations/amazon/disconnect", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: () =>
      apiFetch("/api/profiles", { schema: z.array(amazonProfileSchema) }),
  });
}

export function useUpdateProfile(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileUpdate) =>
      apiFetch(`/api/profiles/${profileId}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}

export function useEnqueueSync(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/profiles/${profileId}/syncs`, {
        method: "POST",
        schema: syncRunSchema,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
      qc.invalidateQueries({ queryKey: ["data-freshness"] });
    },
  });
}

/**
 * Recent sync runs with per-report progress. Polls only while a run is
 * active, so an in-flight sync flips to done without a manual refresh. When
 * the last active run finishes, freshness and summary are invalidated so the
 * just-imported data shows up everywhere on the page.
 */
export function useSyncRuns() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["sync-runs"],
    queryFn: () =>
      apiFetch("/api/syncs", { schema: z.array(syncRunSummarySchema) }),
    refetchInterval: (q) =>
      q.state.data?.some((run) => run.status === "running") ? 10_000 : false,
  });
  const anyRunning =
    query.data?.some((run) => run.status === "running") ?? false;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !anyRunning) {
      qc.invalidateQueries({ queryKey: ["data-freshness"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    }
    wasRunning.current = anyRunning;
  }, [anyRunning, qc]);
  return query;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * Normalizes the global product filter into the API's comma-separated `books`
 * query param (sorted so the query key is stable regardless of check order).
 * Returns undefined when no books are selected.
 */
function booksParam(bookIds?: string[]): string | undefined {
  return bookIds && bookIds.length > 0
    ? [...bookIds].sort().join(",")
    : undefined;
}

export function useDashboardSummary(
  days: MetricWindow,
  country = "US",
  bookIds?: string[],
) {
  const books = booksParam(bookIds);
  return useQuery({
    queryKey: ["dashboard-summary", days, country, books ?? null],
    queryFn: () =>
      apiFetch("/api/dashboard/summary", {
        query: { days, country, books },
        schema: dashboardSummaryResponseSchema,
      }),
  });
}

export function useCountrySpend(days: MetricWindow, bookIds?: string[]) {
  const books = booksParam(bookIds);
  return useQuery({
    queryKey: ["dashboard-country-spend", days, books ?? null],
    queryFn: () =>
      apiFetch("/api/dashboard/country-spend", {
        query: { days, books },
        schema: countrySpendSchema,
      }),
  });
}

export function useDataFreshness() {
  return useQuery({
    queryKey: ["data-freshness"],
    queryFn: () =>
      apiFetch("/api/system/data-freshness", {
        schema: z.array(dataFreshnessSchema),
      }),
  });
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export function useCampaigns(days: MetricWindow = 30, bookIds?: string[]) {
  const books = booksParam(bookIds);
  return useQuery({
    queryKey: ["campaigns", days, books ?? null],
    queryFn: () =>
      apiFetch("/api/campaigns", {
        query: { days, books },
        schema: z.array(campaignListRowSchema),
      }),
  });
}

export function useCampaign(
  campaignId: string,
  days: MetricWindow,
  bookIds?: string[],
) {
  const books = booksParam(bookIds);
  return useQuery({
    queryKey: ["campaign", campaignId, days, books ?? null],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}`, {
        query: { days, books },
        schema: campaignDetailSchema,
      }),
  });
}

export function useCampaignMaxCpc(campaignId: string) {
  return useQuery({
    queryKey: ["campaign-max-cpc", campaignId],
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/max-cpc`, {
        schema: campaignMaxCpcSchema,
      }),
  });
}

export function useSetCampaignMaxCpc(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { maxCpc: string }) =>
      apiFetch(`/api/campaigns/${campaignId}/max-cpc`, {
        method: "POST",
        body,
        schema: maxCpcChangeSetResultSchema,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["campaign-max-cpc", campaignId] }),
        qc.invalidateQueries({ queryKey: ["change-sets"] }),
      ]);
    },
  });
}

/** One-click guarded pause/enable of a campaign. */
export function useUpdateCampaignState(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { state: "enabled" | "paused" }) =>
      apiFetch(`/api/campaigns/${campaignId}/state`, {
        method: "POST",
        body,
        schema: campaignUpdateResultSchema,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["campaign", campaignId] }),
        qc.invalidateQueries({ queryKey: ["campaigns"] }),
        qc.invalidateQueries({ queryKey: ["change-sets"] }),
      ]);
    },
  });
}

/** One-click guarded rename of a campaign. */
export function useRenameCampaign(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) =>
      apiFetch(`/api/campaigns/${campaignId}/name`, {
        method: "POST",
        body,
        schema: campaignUpdateResultSchema,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["campaign", campaignId] }),
        qc.invalidateQueries({ queryKey: ["campaigns"] }),
        qc.invalidateQueries({ queryKey: ["change-sets"] }),
      ]);
    },
  });
}

export function useCreateCampaignDrafts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignCreationCreate) =>
      apiFetch("/api/campaign-creation-change-sets", {
        method: "POST",
        body,
        schema: campaignCreationResultSchema,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["change-sets"] }),
        qc.invalidateQueries({ queryKey: ["campaigns"] }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Search terms
// ---------------------------------------------------------------------------

export function useSearchTerms(
  days: MetricWindow = 30,
  bookIds?: string[],
  countryCode?: string,
) {
  const books = booksParam(bookIds);
  return useQuery({
    queryKey: ["search-terms", days, books ?? null, countryCode ?? null],
    queryFn: () =>
      apiFetch("/api/search-terms", {
        query: { days, books, country: countryCode },
        schema: z.array(searchTermListRowSchema),
      }),
  });
}

export function useSearchTerm(
  term: string,
  days: MetricWindow,
  bookIds?: string[],
  countryCode?: string,
) {
  const books = booksParam(bookIds);
  return useQuery({
    queryKey: ["search-term", term, days, books ?? null, countryCode ?? null],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiFetch(`/api/search-terms/${encodeURIComponent(term)}`, {
        query: { days, books, country: countryCode },
        schema: searchTermDetailSchema,
      }),
  });
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export function useRecommendations(
  filters?: {
    type?: RecommendationType;
    state?: RecommendationState;
  },
  bookIds?: string[],
) {
  const books = booksParam(bookIds);
  return useQuery({
    queryKey: ["recommendations", filters ?? {}, books ?? null],
    queryFn: () =>
      apiFetch("/api/recommendations", {
        query: { type: filters?.type, state: filters?.state, books },
        schema: z.array(recommendationSchema),
      }),
  });
}

export function useRecommendation(id: string) {
  return useQuery({
    queryKey: ["recommendation", id],
    queryFn: () =>
      apiFetch(`/api/recommendations/${id}`, {
        schema: recommendationSchema,
      }),
  });
}

export function useCannibalizationResolutionContext(id: string) {
  return useQuery({
    queryKey: ["recommendation", id, "cannibalization-context"],
    queryFn: () =>
      apiFetch(`/api/recommendations/${id}/cannibalization-context`, {
        schema: cannibalizationResolutionContextSchema,
      }),
  });
}

export function useCreateCannibalizationChangeSet(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { destinationCampaignId: string }) =>
      apiFetch(`/api/recommendations/${id}/cannibalization-change-set`, {
        method: "POST",
        body,
        schema: changeSetSchema,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["recommendations"] }),
        qc.invalidateQueries({ queryKey: ["recommendation", id] }),
        qc.invalidateQueries({ queryKey: ["change-sets"] }),
      ]);
    },
  });
}

export function useConversionResolutionContext(id: string) {
  return useQuery({
    queryKey: ["recommendation", id, "conversion-context"],
    queryFn: () =>
      apiFetch(`/api/recommendations/${id}/conversion-context`, {
        schema: conversionResolutionContextSchema,
      }),
  });
}

/** Draft campaign-level negatives for chosen shopper terms (no apply). */
export function useCreateCampaignNegatives(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignNegativesCreate) =>
      apiFetch(`/api/campaigns/${campaignId}/negatives`, {
        method: "POST",
        body,
        schema: changeSetSchema,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["change-sets"] }),
  });
}

/** Reject a finding; `snoozeDays` asks to be reminded sooner than the default. */
export function useRejectRecommendation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: RejectRecommendation) =>
      apiFetch(`/api/recommendations/${id}/reject`, {
        method: "POST",
        body: body ?? {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recommendations"] });
      qc.invalidateQueries({ queryKey: ["recommendation", id] });
    },
  });
}

export function useCreateChangeSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangeSetCreate) =>
      apiFetch("/api/recommendations/change-sets", {
        method: "POST",
        body,
        schema: changeSetSchema,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["change-sets"] }),
  });
}

// ---------------------------------------------------------------------------
// Change center
// ---------------------------------------------------------------------------

// API-GAP: plan §11 has no GET /api/change-sets list route; the change center
// needs one. Assumed to return ChangeSet[].
export function useChangeSets() {
  return useQuery({
    queryKey: ["change-sets"],
    queryFn: () =>
      apiFetch("/api/change-sets", { schema: z.array(changeSetSchema) }),
  });
}

export function useChangeSetPreview(changeSetId: string | null) {
  return useQuery({
    queryKey: ["change-set-preview", changeSetId],
    enabled: changeSetId != null,
    queryFn: () =>
      apiFetch(`/api/change-sets/${changeSetId}/preview`, {
        schema: changeSetPreviewSchema,
      }),
  });
}

export function useApplyChangeSet(changeSetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/change-sets/${changeSetId}/apply`, { method: "POST" }),
    // onSettled: even a failed request can change server state (the guarded
    // path records per-item failures and flips the set to failed before
    // throwing), so always refresh both the list and the action rows.
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["change-sets"] }),
        qc.invalidateQueries({ queryKey: ["change-set-preview"] }),
        qc.invalidateQueries({ queryKey: ["campaign-max-cpc"] }),
        qc.invalidateQueries({ queryKey: ["campaign"] }),
      ]);
    },
  });
}

export function useRollbackChangeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (actionId: string) =>
      apiFetch(`/api/change-actions/${actionId}/rollback`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["change-sets"] });
      qc.invalidateQueries({ queryKey: ["change-set-preview"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Books, audit
// ---------------------------------------------------------------------------

export function useBooks() {
  return useQuery({
    queryKey: ["books"],
    queryFn: () => apiFetch("/api/books", { schema: z.array(bookSchema) }),
  });
}

export function useUnmappedAdvertisedProducts() {
  return useQuery({
    queryKey: ["books", "unmapped-products"],
    queryFn: () =>
      apiFetch("/api/books/unmapped-products", {
        schema: z.array(advertisedBookCandidateSchema),
      }),
  });
}

export function useMapAdvertisedBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BookMappingInput) =>
      apiFetch("/api/books/mappings", {
        method: "POST",
        body,
        schema: bookSchema,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["books"] }),
        qc.invalidateQueries({ queryKey: ["audit-events"] }),
      ]);
    },
  });
}

export function useLinkBookToMarkets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      bookId,
      ...body
    }: BookProfileLinkInput & { bookId: string }) =>
      apiFetch(`/api/books/${bookId}/profile-links`, {
        method: "POST",
        body,
        schema: bookSchema,
      }),
    onSuccess: async (updated) => {
      qc.setQueryData<Book[]>(["books"], (previous) => {
        if (!previous) return [updated];
        return previous.map((book) =>
          book.id === updated.id ? updated : book,
        );
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["books"] }),
        qc.invalidateQueries({ queryKey: ["audit-events"] }),
      ]);
    },
  });
}

export function useSaveBookEconomics(bookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BookEconomicsInput) =>
      apiFetch(`/api/books/${bookId}/economics`, { method: "POST", body }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["books"] }),
        qc.invalidateQueries({ queryKey: ["campaign"] }),
        qc.invalidateQueries({ queryKey: ["dashboard-summary"] }),
      ]);
    },
  });
}

export function useSaveBookCover(bookId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BookCoverInput) =>
      apiFetch(`/api/books/${bookId}/cover`, { method: "PUT", body }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["books"] }),
        qc.invalidateQueries({ queryKey: ["audit-events"] }),
      ]);
    },
  });
}

export function useAuditEvents() {
  return useQuery({
    queryKey: ["audit-events"],
    queryFn: () =>
      apiFetch("/api/audit-events", { schema: z.array(auditEventSchema) }),
  });
}
