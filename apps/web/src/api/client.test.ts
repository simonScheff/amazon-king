import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch, getCsrfToken, setCsrfToken } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    setCsrfToken(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON for a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { ok: true })),
    );
    await expect(apiFetch("/api/session")).resolves.toEqual({ ok: true });
  });

  it("normalizes a {error:{message,code}} body into ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, {
          error: { message: "Forbidden", code: "forbidden" },
        }),
      ),
    );
    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe("Forbidden");
    expect((err as ApiError).code).toBe("forbidden");
  });

  it("normalizes a plain {message} body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );
    const err = await apiFetch("/api/session").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe("Unauthorized");
  });

  it("falls back to status text when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("oops", { status: 500, statusText: "Server Error" }),
      ),
    );
    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it("sends the CSRF header on mutations but not on GET", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {}),
    );
    vi.stubGlobal("fetch", spy);
    setCsrfToken("tok-123");

    await apiFetch("/api/a", { method: "POST", body: { x: 1 } });
    await apiFetch("/api/b");

    const postInit = spy.mock.calls[0]?.[1];
    const getInit = spy.mock.calls[1]?.[1];
    expect((postInit?.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "tok-123",
    );
    expect(getCsrfToken()).toBe("tok-123");
    expect(
      (getInit?.headers as Record<string, string>)["x-csrf-token"],
    ).toBeUndefined();
    expect(postInit?.credentials).toBe("same-origin");
  });

  it("validates responses against a zod schema when given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { n: "nope" })),
    );
    await expect(
      apiFetch("/api/x", { schema: z.object({ n: z.number() }) }),
    ).rejects.toThrow();
  });

  it("appends query params, skipping undefined", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {}),
    );
    vi.stubGlobal("fetch", spy);
    await apiFetch("/api/dashboard/summary", {
      query: { days: 30, type: undefined },
    });
    expect(spy.mock.calls[0]?.[0]).toBe("/api/dashboard/summary?days=30");
  });
});
