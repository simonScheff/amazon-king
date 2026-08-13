import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  amazonConnectionStatusSchema,
  amazonProfileSchema,
  advertisedBookCandidateSchema,
  auditEventSchema,
  bookSchema,
  campaignRowSchema,
  changeActionSchema,
  changeSetSchema,
  dashboardSummarySchema,
  dataFreshnessSchema,
  isoDateSchema,
  metricTotalsSchema,
  nonNegativeDecimalStringSchema,
  recommendationSchema,
  sessionInfoSchema,
  syncRunSchema,
  type BookMappingInput,
  type BookEconomicsInput,
  type ChangeSetCreate,
  type LoginRequest,
  type ProfileUpdate,
  type RecommendationState,
  type RecommendationType,
} from "@amazon-king/contracts";
import { apiFetch, setCsrfToken } from "./client";

// ---------------------------------------------------------------------------
// Response schemas. Where the contracts package does not yet define a shape
// for an endpoint, a local schema is defined here (see API-GAPS notes).
// ---------------------------------------------------------------------------

// API-GAP: SessionInfo in contracts has no csrfToken field, but the browser
// needs one to send x-csrf-token on mutations.
const sessionResponseSchema = sessionInfoSchema.extend({
  csrfToken: z.string(),
});

// API-GAP: DashboardSummary has no daily trend series and no writesDisabled
// kill-switch flag; both are tolerated as optional additive fields.
export const dashboardSummaryResponseSchema = dashboardSummarySchema.extend({
  writesDisabled: z.boolean().optional(),
  daily: z
    .array(
      z.object({
        date: isoDateSchema,
        cost: nonNegativeDecimalStringSchema,
        sales: nonNegativeDecimalStringSchema,
        estimatedRoyalty: nonNegativeDecimalStringSchema.nullable(),
      }),
    )
    .optional(),
});
export type DashboardSummaryResponse = z.infer<
  typeof dashboardSummaryResponseSchema
>;

const amazonStartResponseSchema = z.object({ url: z.string() });

// API-GAP: no contract for GET /api/campaigns/:id (detail with hierarchy).
const namedMetricRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  totals: metricTotalsSchema,
});
export const campaignDetailSchema = z.object({
  campaign: campaignRowSchema,
  adGroups: z.array(namedMetricRowSchema).default([]),
  targets: z.array(namedMetricRowSchema).default([]),
  searchTerms: z.array(namedMetricRowSchema).default([]),
});
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
      apiFetch("/api/session/login", { method: "POST", body }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/api/session/logout", { method: "POST" }),
    onSuccess: () => {
      setCsrfToken(null);
      qc.clear();
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

export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () =>
      apiFetch("/api/campaigns", { schema: z.array(campaignRowSchema) }),
  });
}

export function useCampaign(campaignId: string) {
  return useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}`, {
        schema: campaignDetailSchema,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["change-sets"] }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["books"] }),
  });
}

export function useAuditEvents() {
  return useQuery({
    queryKey: ["audit-events"],
    queryFn: () =>
      apiFetch("/api/audit-events", { schema: z.array(auditEventSchema) }),
  });
}
