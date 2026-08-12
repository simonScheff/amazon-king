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
