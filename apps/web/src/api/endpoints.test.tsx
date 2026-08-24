import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCsrfToken, setCsrfToken } from "./client";
import {
  useCreateSearchTermExclusion,
  useDashboardSummary,
  useDataFreshness,
  useDeleteSearchTermExclusion,
  useEnqueueFxSync,
  useLogout,
  useSearchTermExclusions,
  useUpdateWorkspaceSettings,
} from "./endpoints";

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("session endpoint hooks", () => {
  afterEach(() => {
    setCsrfToken(null);
    vi.unstubAllGlobals();
  });

  it("keeps the mutation observer alive while sign out removes session data", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    setCsrfToken("csrf-before-logout");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["session"], { userId: "owner" });
    const remove = vi.spyOn(queryClient, "removeQueries");
    const clear = vi.spyOn(queryClient, "clear");

    const { result } = renderHook(() => useLogout(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/session/logout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-before-logout",
        }),
      }),
    );
    expect(getCsrfToken()).toBeNull();
    expect(remove).toHaveBeenCalledWith({
      queryKey: ["session"],
      exact: true,
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it("refreshes a stale CSRF token once before retrying sign out", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Invalid CSRF token" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: "owner",
            workspaceId: "workspace",
            email: "owner@example.com",
            expiresAt: "2026-08-20T00:00:00.000Z",
            csrfToken: "fresh-token",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    setCsrfToken("stale-token");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(() => useLogout(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/session");
    expect(fetchSpy.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "x-csrf-token": "fresh-token" }),
    });
  });
});

describe("workspace settings hooks", () => {
  afterEach(() => {
    setCsrfToken(null);
    vi.unstubAllGlobals();
  });

  it("PATCHes the display currency, seeds the settings cache, and invalidates dashboard queries", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ displayCurrency: "EUR" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    setCsrfToken("csrf-token");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateWorkspaceSettings(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ displayCurrency: "EUR" });
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/workspace/settings",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
        body: JSON.stringify({ displayCurrency: "EUR" }),
      }),
    );
    expect(queryClient.getQueryData(["workspace-settings"])).toEqual({
      displayCurrency: "EUR",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["dashboard-summary"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["dashboard-country-spend"],
    });
  });
});

describe("fx sync hooks", () => {
  afterEach(() => {
    setCsrfToken(null);
    vi.unstubAllGlobals();
  });

  it("POSTs the manual FX sync trigger and invalidates data freshness", async () => {
    const result = {
      latestRateDate: "2026-08-20",
      lastRunState: "succeeded",
      lastRunAt: "2026-08-20T17:01:00.000Z",
      lastError: null,
      stale: false,
      queued: true,
    };
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    setCsrfToken("csrf-token");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result: mutation } = renderHook(() => useEnqueueFxSync(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await mutation.current.mutateAsync();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/fx-rates/sync",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["data-freshness"] });
  });
});

describe("dashboard query hooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the all-market country and display currency on the summary request", async () => {
    const summary = {
      dateRange: { start: "2026-07-22", end: "2026-08-20" },
      currency: "EUR",
      ratesAvailable: true,
      totals: {
        impressions: 0,
        clicks: 0,
        cost: "0.0000",
        sales: "0.0000",
        orders: 0,
        units: 0,
        acos: null,
        estimatedRoyalty: null,
        estimatedAdProfit: null,
      },
      previous: {
        dateRange: { start: "2026-06-22", end: "2026-07-21" },
        totals: {
          impressions: 0,
          clicks: 0,
          cost: "0.0000",
          sales: "0.0000",
          orders: 0,
          units: 0,
          acos: null,
          estimatedRoyalty: null,
          estimatedAdProfit: null,
        },
      },
      economicsMissing: true,
      dataCurrentThrough: "2026-08-20T12:00:00.000Z",
      daily: [],
    };
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify(summary), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(
      () => useDashboardSummary(30, "all", ["7", "3"], "EUR"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("country=all");
    expect(String(url)).toContain("currency=EUR");
    expect(String(url)).toContain("books=3%2C7");
    expect(result.current.data?.currency).toBe("EUR");
  });

  it("validates the data-freshness envelope with per-profile rows and FX health", async () => {
    const payload = {
      profiles: [
        {
          profileId: "profile-us",
          countryCode: "US",
          dataset: "metrics",
          lastSuccessAt: "2026-08-20T05:00:00.000Z",
          completeThrough: "2026-08-19",
          hasCampaigns: true,
        },
      ],
      fxRates: {
        latestRateDate: "2026-08-20",
        lastRunState: "succeeded",
        lastRunAt: "2026-08-20T17:01:00.000Z",
        lastError: null,
        stale: false,
      },
    };
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useDataFreshness(), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.profiles).toHaveLength(1);
    expect(result.current.data?.fxRates.lastRunState).toBe("succeeded");
  });
});

describe("search-term exclusion hooks", () => {
  afterEach(() => {
    setCsrfToken(null);
    vi.unstubAllGlobals();
  });

  it("GETs the exclusion list", async () => {
    const payload = {
      exclusions: [{ term: "dragons", createdAt: "2026-08-20T10:00:00.000Z" }],
    };
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useSearchTermExclusions(), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/search-terms/exclusions",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.current.data?.exclusions[0]?.term).toBe("dragons");
  });

  it("POSTs the encoded term and invalidates exclusions, search terms, and change sets", async () => {
    const payload = {
      term: "fantasy books",
      created: true,
      changeSets: [
        { changeSetId: "41", profileId: "profile-us", campaignCount: 2 },
      ],
      skippedCampaigns: 0,
    };
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    setCsrfToken("csrf-token");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useCreateSearchTermExclusion("fantasy books"),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/search-terms/fantasy%20books/exclusion",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["search-term-exclusions"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search-terms"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["change-sets"] });
  });

  it("DELETEs the encoded term and invalidates the list and search terms", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ removed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    setCsrfToken("csrf-token");
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteSearchTermExclusion(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync("fantasy books");
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/search-terms/fantasy%20books/exclusion",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["search-term-exclusions"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search-terms"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["change-sets"] });
  });
});
