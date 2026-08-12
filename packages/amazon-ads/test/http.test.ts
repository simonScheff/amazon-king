import { afterEach, describe, expect, it, vi } from "vitest";
import { REGION_HOSTS, parseRetryAfterMs } from "../src/http.js";
import { AmazonApiError, AmazonNetworkError } from "../src/errors.js";
import {
  TEST_CONTEXT,
  captureLogs,
  jsonResponse,
  makeHttp,
} from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("header derivation (plan §6)", () => {
  it("sends product-endpoint headers derived from the typed profile context", async () => {
    const { http, calls } = makeHttp({ handler: () => jsonResponse({}) });
    await http.request({
      method: "GET",
      path: "/sp/campaigns/list",
      context: TEST_CONTEXT,
    });
    const headers = calls[0].headers;
    expect(headers.authorization).toBe(`Bearer ${TEST_CONTEXT.accessToken}`);
    expect(headers["Amazon-Advertising-API-ClientId"]).toBe(
      "lwa-test-client-id",
    );
    expect(headers["Amazon-Advertising-API-Scope"]).toBe(
      TEST_CONTEXT.profileId,
    );
    expect(headers["Amazon-Ads-AccountId"]).toBeUndefined();
  });

  it("sends Unified API headers when flavor is unified", async () => {
    const { http, calls } = makeHttp({ handler: () => jsonResponse({}) });
    await http.request({
      method: "POST",
      path: "/adsApi/v1/query/campaigns",
      context: TEST_CONTEXT,
      flavor: "unified",
      body: {},
    });
    const headers = calls[0].headers;
    expect(headers["Amazon-Ads-ClientId"]).toBe("lwa-test-client-id");
    expect(headers["Amazon-Ads-AccountId"]).toBe(TEST_CONTEXT.accountId);
    expect(headers["Amazon-Advertising-API-Scope"]).toBeUndefined();
  });

  it("refuses Unified API calls without a stored account id", async () => {
    const { http, calls } = makeHttp({ handler: () => jsonResponse({}) });
    await expect(
      http.request({
        method: "GET",
        path: "/adsApi/v1/query/campaigns",
        context: { ...TEST_CONTEXT, accountId: null },
        flavor: "unified",
      }),
    ).rejects.toBeInstanceOf(AmazonApiError);
    expect(calls).toHaveLength(0);
  });

  it("routes to the regional host", async () => {
    const { http, calls } = makeHttp({ handler: () => jsonResponse({}) });
    for (const region of ["NA", "EU", "FE"] as const) {
      await http.request({
        method: "GET",
        path: "/v2/profiles",
        context: { region, accessToken: TEST_CONTEXT.accessToken },
      });
    }
    expect(calls[0].url).toBe(`${REGION_HOSTS.NA}/v2/profiles`);
    expect(calls[1].url).toBe(`${REGION_HOSTS.EU}/v2/profiles`);
    expect(calls[2].url).toBe(`${REGION_HOSTS.FE}/v2/profiles`);
  });
});

describe("retry policy (plan §8)", () => {
  it("honors Retry-After on 429", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const { http } = makeHttp({
      handler: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse(
              { code: "TOO_MANY_REQUESTS" },
              { status: 429, headers: { "retry-after": "2" } },
            )
          : jsonResponse({ ok: true });
      },
      // Real setTimeout-based sleep so fake timers control the retry delay.
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const pending = http.request({
      method: "GET",
      path: "/sp/campaigns/list",
      context: TEST_CONTEXT,
    });
    const outcome = await Promise.all([
      pending,
      vi.advanceTimersByTimeAsync(2500),
    ]);
    expect(attempt).toBe(2);
    expect((outcome[0] as { data: unknown }).data).toEqual({ ok: true });
  });

  it("applies exponential backoff with full jitter within bounds", async () => {
    const delays: number[] = [];
    const { http, calls } = makeHttp({
      handler: (request, n) =>
        n < 3 ? jsonResponse({}, { status: 503 }) : jsonResponse({ ok: 1 }),
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
      retry: { baseDelayMs: 100, maxDelayMs: 10_000 },
    });
    await http.request({
      method: "GET",
      path: "/x",
      context: TEST_CONTEXT,
    });
    expect(calls).toHaveLength(3);
    // Full jitter: uniform in [0, min(cap, base * 2^attempt)].
    expect(delays).toEqual([50, 100]);

    const zeroDelays: number[] = [];
    const { http: http2 } = makeHttp({
      handler: (r, n) =>
        n < 2 ? jsonResponse({}, { status: 503 }) : jsonResponse({ ok: 1 }),
      sleep: async (ms) => {
        zeroDelays.push(ms);
      },
      random: () => 0,
      retry: { baseDelayMs: 100 },
    });
    await http2.request({ method: "GET", path: "/x", context: TEST_CONTEXT });
    expect(zeroDelays).toEqual([0]);
  });

  it("caps backoff at maxDelayMs", async () => {
    const delays: number[] = [];
    const { http } = makeHttp({
      handler: (r, n) =>
        n < 4 ? jsonResponse({}, { status: 500 }) : jsonResponse({ ok: 1 }),
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.999999,
      retry: { baseDelayMs: 1000, maxDelayMs: 2000 },
    });
    await http.request({ method: "GET", path: "/x", context: TEST_CONTEXT });
    // caps: 1000, 2000, 2000 → jitter just below cap
    expect(delays).toEqual([999, 1999, 1999]);
  });

  it("does not retry validation failures or most 4xx", async () => {
    const { http, calls } = makeHttp({
      handler: () =>
        jsonResponse(
          { code: "VALIDATION_ERROR", message: "bad field" },
          {
            status: 400,
          },
        ),
    });
    const error = await http
      .request({ method: "POST", path: "/sp/keywords", context: TEST_CONTEXT })
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(AmazonApiError);
    expect((error as AmazonApiError).status).toBe(400);
    expect((error as AmazonApiError).retryable).toBe(false);
  });

  it("gives up after maxAttempts and reports a retryable error", async () => {
    const { http, calls } = makeHttp({
      handler: () => jsonResponse({}, { status: 503 }),
      retry: { maxAttempts: 3 },
    });
    const error = await http
      .request({ method: "GET", path: "/x", context: TEST_CONTEXT })
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(AmazonApiError);
    expect((error as AmazonApiError).retryable).toBe(true);
  });

  it("retries network failures and then raises AmazonNetworkError", async () => {
    const delays: number[] = [];
    const { http, calls } = makeHttp({
      handler: () => {
        throw new TypeError("fetch failed");
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    });
    const error = await http
      .request({ method: "GET", path: "/x", context: TEST_CONTEXT })
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(AmazonNetworkError);
    expect((error as AmazonNetworkError).retryable).toBe(true);
    expect(delays).toHaveLength(2);
  });
});

describe("observability", () => {
  it("records Amazon request ids in structured logs", async () => {
    const { http, logs } = makeHttp({
      handler: () =>
        jsonResponse(
          { code: "BAD" },
          { status: 400, headers: { "x-amzn-requestid": "req-abc-123" } },
        ),
    });
    const error = await http
      .request({ method: "GET", path: "/x", context: TEST_CONTEXT })
      .catch((e: unknown) => e);
    expect((error as AmazonApiError).requestId).toBe("req-abc-123");
    expect(logs.text()).toContain("req-abc-123");
  });

  it("redacts sensitive keys from error response details", async () => {
    const { http, logs } = makeHttp({
      handler: () =>
        jsonResponse(
          { message: "failed", token: "Atza|leak", authorization: "Bearer x" },
          { status: 400 },
        ),
    });
    const error = (await http
      .request({ method: "GET", path: "/x", context: TEST_CONTEXT })
      .catch((e: unknown) => e)) as AmazonApiError;
    expect(logs.text()).not.toContain("Atza|leak");
    expect(JSON.stringify(error.details)).not.toContain("Atza|leak");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(null)).toBeNull();
    const future = new Date(10_000).toUTCString();
    expect(parseRetryAfterMs(future, () => 4_000)).toBe(6_000);
    expect(parseRetryAfterMs("garbage")).toBeNull();
  });
});
