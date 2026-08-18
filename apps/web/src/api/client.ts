import { z } from "zod";

/** Normalized API error thrown by apiFetch for any non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let csrfToken: string | null = null;

/** True for 401 REAUTH_REQUIRED: the action needs a fresher app sign-in. */
export function isReauthError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "REAUTH_REQUIRED";
}

/** Called after every GET /api/session so mutations can send the CSRF header. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

type Query = Record<string, string | number | boolean | undefined>;

interface ApiFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Query;
}

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const errorBodySchema = z
  .object({
    message: z.string().optional(),
    code: z.string().optional(),
    error: z
      .object({ message: z.string().optional(), code: z.string().optional() })
      .optional(),
  })
  .loose();

async function normalizeError(res: Response): Promise<ApiError> {
  let message = res.statusText || `Request failed with status ${res.status}`;
  let code: string | undefined;
  try {
    const parsed = errorBodySchema.safeParse(await res.json());
    if (parsed.success) {
      message = parsed.data.error?.message ?? parsed.data.message ?? message;
      code = parsed.data.error?.code ?? parsed.data.code;
    }
  } catch {
    // Body was not JSON — keep the status-based message.
  }
  return new ApiError(res.status, message, code);
}

/**
 * Redeems a magic-link token from inside the app instead of by following the
 * emailed link. Needed by the installed app on iOS, which has its own cookie
 * container: an emailed link always opens in the browser, whose session cookie
 * the installed app can never see. Fetching verify here stores the cookie in
 * the container that runs this code.
 *
 * Verify answers with a redirect either way, so failure is detected from the
 * URL it lands on rather than from a status code.
 */
export async function redeemLoginToken(token: string): Promise<void> {
  const res = await fetch(buildUrl("/api/session/verify", { token }), {
    credentials: "same-origin",
  });
  if (!res.ok) throw await normalizeError(res);

  const landed = new URL(res.url, window.location.origin);
  if (landed.searchParams.get("error") === "invalid_token") {
    throw new ApiError(
      401,
      "This sign-in link is invalid, expired, or already used. Request a new one.",
      "INVALID_TOKEN",
    );
  }
}

/**
 * Typed fetch wrapper for the application API. Sends credentials (session
 * cookie) on every request and the CSRF header on mutations. Optionally
 * validates the response against a Zod schema from @amazon-king/contracts.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions & { schema?: z.ZodType<T> } = {},
): Promise<T> {
  const { method = "GET", body, query, schema } = options;
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;

  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw await normalizeError(res);
  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json();
  if (schema) return schema.parse(data);
  return data as T;
}
