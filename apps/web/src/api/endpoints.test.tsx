import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCsrfToken, setCsrfToken } from "./client";
import { useLogout } from "./endpoints";

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
