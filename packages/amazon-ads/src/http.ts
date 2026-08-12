import { redactSecrets } from "@amazon-king/observability";
import type { AmazonRegion } from "./types.js";
import { AmazonApiError, AmazonNetworkError } from "./errors.js";
import { defaultLogger, type LoggerLike } from "./logger.js";
import type { FetchLike } from "./oauth.js";

/**
 * Authenticated HTTP transport for the Amazon Ads API (plan §6 hosts/headers,
 * §8 backoff and rate limits). Headers are derived from stored profile/account
 * metadata passed in as a typed context — never from arbitrary caller input.
 */

export const REGION_HOSTS: Record<AmazonRegion, string> = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com",
};

export const ALL_REGIONS: AmazonRegion[] = ["NA", "EU", "FE"];

/** Product-specific endpoints (SP v3, Reporting v3) vs. Unified API headers. */
export type ApiFlavor = "product" | "unified";

export interface AdsRequestContext {
  region: AmazonRegion;
  accessToken: string;
  /** Profile scope for product endpoints; omit for profile-less calls (GET /v2/profiles). */
  profileId?: string;
  /** Unified API account id; required when flavor is "unified". */
  accountId?: string | null;
}

export interface AdsRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  context: AdsRequestContext;
  flavor?: ApiFlavor;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}

export interface AdsResponse {
  status: number;
  data: unknown;
  /** Amazon's x-amzn-requestid (or equivalent), for support traces. */
  requestId: string | null;
}

export interface RetryPolicyOptions {
  /** Total attempts including the first (default 5). */
  maxAttempts: number;
  /** Base for exponential backoff in ms (default 500). */
  baseDelayMs: number;
  /** Backoff cap in ms (default 30000). */
  maxDelayMs: number;
}

export interface AdsHttpClientOptions {
  clientId: string;
  fetch?: FetchLike;
  logger?: LoggerLike;
  retry?: Partial<RetryPolicyOptions>;
  /** Injectable for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
}

export interface AdsHttpClient {
  request(request: AdsRequest): Promise<AdsResponse>;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const REQUEST_ID_HEADERS = ["x-amzn-requestid", "x-amz-request-id"];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRequestId(headers: Headers): string | null {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) {
      return value;
    }
  }
  return null;
}

/** Retry-After: either delta-seconds or an HTTP date. Returns null when absent/invalid. */
export function parseRetryAfterMs(
  value: string | null,
  now: () => number = () => Date.now(),
): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now());
  }
  return null;
}

function buildHeaders(
  clientId: string,
  context: AdsRequestContext,
  flavor: ApiFlavor,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${context.accessToken}`,
  };
  if (flavor === "unified") {
    if (!context.accountId) {
      throw new AmazonApiError(
        "Unified API calls require a stored Amazon-Ads-AccountId",
        { status: 0 },
      );
    }
    headers["Amazon-Ads-ClientId"] = clientId;
    headers["Amazon-Ads-AccountId"] = context.accountId;
  } else {
    headers["Amazon-Advertising-API-ClientId"] = clientId;
    if (context.profileId) {
      headers["Amazon-Advertising-API-Scope"] = context.profileId;
    }
  }
  if (hasBody) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

export function createAdsHttpClient(
  options: AdsHttpClientOptions,
): AdsHttpClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? defaultLogger();
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? (() => Math.random());
  const retry: RetryPolicyOptions = {
    maxAttempts: options.retry?.maxAttempts ?? 5,
    baseDelayMs: options.retry?.baseDelayMs ?? 500,
    maxDelayMs: options.retry?.maxDelayMs ?? 30_000,
  };
  const defaultTimeoutMs = options.timeoutMs ?? 30_000;

  /** Exponential backoff with FULL jitter: uniform in [0, min(cap, base * 2^attempt)]. */
  function backoffMs(attempt: number): number {
    const cap = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
    return Math.floor(random() * cap);
  }

  async function request(req: AdsRequest): Promise<AdsResponse> {
    const flavor = req.flavor ?? "product";
    const url = new URL(REGION_HOSTS[req.context.region] + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = buildHeaders(
      options.clientId,
      req.context,
      flavor,
      req.body !== undefined,
    );
    const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
    const logContext = {
      method: req.method,
      path: req.path,
      region: req.context.region,
      flavor,
      profileId: req.context.profileId,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: req.method,
          headers,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Network error or timeout: retryable with full jitter.
        lastError = error;
        if (attempt < retry.maxAttempts - 1) {
          const delayMs = backoffMs(attempt);
          logger.warn(
            { ...logContext, attempt: attempt + 1, delayMs },
            "Amazon request failed before response; retrying",
          );
          await sleep(delayMs);
          continue;
        }
        throw new AmazonNetworkError(
          `Amazon request to ${req.path} failed after ${retry.maxAttempts} attempts`,
          { cause: error },
        );
      }

      const requestId = extractRequestId(response.headers);
      if (response.ok) {
        const data = response.status === 204 ? null : await response.json();
        logger.debug(
          { ...logContext, status: response.status, requestId },
          "Amazon request succeeded",
        );
        return { status: response.status, data, requestId };
      }

      // Failure: parse the body for diagnostics, redacted before any logging.
      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        parsedBody = undefined;
      }
      const safeBody = redactSecrets(parsedBody);
      const retryable = RETRYABLE_STATUSES.has(response.status);

      if (retryable && attempt < retry.maxAttempts - 1) {
        // On 429, honor Retry-After when present; otherwise full-jitter backoff.
        const retryAfterMs =
          response.status === 429
            ? parseRetryAfterMs(response.headers.get("retry-after"))
            : null;
        const delayMs = retryAfterMs ?? backoffMs(attempt);
        logger.warn(
          {
            ...logContext,
            status: response.status,
            requestId,
            attempt: attempt + 1,
            delayMs,
            retryAfterHonored: retryAfterMs !== null,
          },
          "Amazon request throttled/failed transiently; retrying",
        );
        await sleep(delayMs);
        lastError = safeBody;
        continue;
      }

      logger.error(
        {
          ...logContext,
          status: response.status,
          requestId,
          body: safeBody,
        },
        "Amazon request failed",
      );
      throw new AmazonApiError(
        `Amazon request to ${req.path} failed with status ${response.status}`,
        {
          status: response.status,
          requestId,
          retryable,
          details: safeBody,
        },
      );
    }
    // Unreachable, but keeps the type checker honest.
    throw new AmazonNetworkError("Amazon request failed", {
      cause: lastError,
    });
  }

  return { request };
}
