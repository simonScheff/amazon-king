import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/oauth.js";
import type { AdsHttpClient } from "../src/http.js";
import { createAdsHttpClient } from "../src/http.js";
import type { LoggerLike } from "../src/logger.js";

/** Load a sanitized JSON fixture from test/fixtures. */
export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON string (Ads API), URLSearchParams (LWA), or undefined. */
  body: unknown;
}

export type FetchHandler = (
  request: RecordedRequest,
  attempt: number,
) => Response | Promise<Response>;

/** Build a fetch mock that records every call; no network I/O is possible. */
export function mockFetch(handler: FetchHandler): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(request);
    return handler(request, calls.length);
  };
  return { fetch, calls };
}

export function jsonResponse(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

export function binaryResponse(
  data: Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(data as BodyInit, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

/** In-memory LoggerLike capturing serialized lines for assertions. */
export function captureLogs(): {
  logger: LoggerLike;
  lines: string[];
  text: () => string;
} {
  const lines: string[] = [];
  const write =
    (level: string) => (obj: Record<string, unknown>, msg: string) => {
      lines.push(JSON.stringify({ level, ...obj, msg }));
    };
  return {
    logger: {
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
    },
    lines,
    text: () => lines.join("\n"),
  };
}

/** Real http client wired to a mock fetch — exercises headers/retry without network. */
export function makeHttp(options: {
  handler: FetchHandler;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
}): {
  http: AdsHttpClient;
  calls: RecordedRequest[];
  logs: ReturnType<typeof captureLogs>;
} {
  const { fetch, calls } = mockFetch(options.handler);
  const logs = captureLogs();
  const http = createAdsHttpClient({
    clientId: "lwa-test-client-id",
    fetch,
    logger: logs.logger,
    sleep: options.sleep ?? (() => Promise.resolve()),
    random: options.random,
    retry: options.retry,
  });
  return { http, calls, logs };
}

export const TEST_CONTEXT = {
  region: "NA" as const,
  accessToken: "Atza|test-access-token",
  profileId: "1111111111",
  accountId: "AMZNACCTUS01",
};
