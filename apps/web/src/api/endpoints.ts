import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  amazonConnectionStatusSchema,
  amazonProfileSchema,
  advertisedBookCandidateSchema,
  auditEventSchema,
  bookSchema,
  campaignDetailSchema,
  campaignListRowSchema,
  campaignMaxCpcSchema,
  cannibalizationResolutionContextSchema,
  changeActionSchema,
  changeSetSchema,
  dashboardSummarySchema,
  dataFreshnessSchema,
  maxCpcChangeSetResultSchema,
  recommendationSchema,
  searchTermDetailSchema,
  searchTermListRowSchema,
  sessionInfoSchema,
  syncRunSchema,
  type BookMappingInput,
  type BookEconomicsInput,
  type BookCoverInput,
  type ChangeSetCreate,
  type LoginRequest,
  type ProfileUpdate,
  type RecommendationState,
  type RecommendationType,
} from "@amazon-king/contracts";
import { ApiError, apiFetch, setCsrfToken } from "./client";

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
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/profiles/${profileId}/syncs`, {
        method: "POST",
        schema: syncRunSchema,
      }),
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function useDashboardSummary(days: number, country = "US") {
  return useQuery({
    queryKey: ["dashboard-summary", days, country],
    queryFn: () =>
      apiFetch("/api/dashboard/summary", {
        query: { days, country },
        schema: dashboardSummaryResponseSchema,
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

export function useCampaigns(days = 7) {
  return useQuery({
    queryKey: ["campaigns", days],
    queryFn: () =>
      apiFetch("/api/campaigns", {
        query: { days },
        schema: z.array(campaignListRowSchema),
      }),
  });
}

export function useCampaign(campaignId: string, days: number) {
  return useQuery({
    queryKey: ["campaign", campaignId, days],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}`, {
        query: { days },
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

// ---------------------------------------------------------------------------
// Search terms
// ---------------------------------------------------------------------------

export function useSearchTerms(days = 7, bookId?: string) {
  return useQuery({
    queryKey: ["search-terms", days, bookId ?? null],
    queryFn: () =>
      apiFetch("/api/search-terms", {
        query: { days, book: bookId },
        schema: z.array(searchTermListRowSchema),
      }),
  });
}

export function useSearchTerm(
  term: string,
  days: number,
  bookId?: string,
  countryCode?: string,
) {
  return useQuery({
    queryKey: ["search-term", term, days, bookId ?? null, countryCode ?? null],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiFetch(`/api/search-terms/${encodeURIComponent(term)}`, {
        query: { days, book: bookId, country: countryCode },
        schema: searchTermDetailSchema,
      }),
  });
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export function useRecommendations(filters?: {
  type?: RecommendationType;
  state?: RecommendationState;
}) {
  return useQuery({
    queryKey: ["recommendations", filters ?? {}],
    queryFn: () =>
      apiFetch("/api/recommendations", {
        query: { type: filters?.type, state: filters?.state },
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

export function useRejectRecommendation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/recommendations/${id}/reject`, { method: "POST" }),
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
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["change-sets"] }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["change-sets"] }),
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
