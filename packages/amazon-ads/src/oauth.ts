import { z } from "zod";
import { redactSecrets } from "@amazon-king/observability";
import { AmazonAuthError } from "./errors.js";
import { defaultLogger, type LoggerLike } from "./logger.js";

/**
 * Login with Amazon (LWA) OAuth client — plan §5. The client secret is only
 * ever sent server-to-server to the token endpoint; it is never logged and
 * never included in error messages.
 */

export const AUTHORIZATION_URL = "https://www.amazon.com/ap/oa";
export const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const ADS_SCOPE = "advertising::campaign_management";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OAuthClientOptions {
  fetch?: FetchLike;
  logger?: LoggerLike;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
});

const errorResponseSchema = z.looseObject({
  error: z.string(),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
});

/** Build the LWA consent URL. Never contains the client secret. */
export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("scope", ADS_SCOPE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

async function postTokenRequest(
  formFields: Record<string, string>,
  options: OAuthClientOptions,
): Promise<z.infer<typeof tokenResponseSchema>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? defaultLogger();
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(formFields),
  });

  if (!response.ok) {
    // Parse Amazon's error payload; redact defensively before it touches logs
    // or the error object, and never echo the request body (which held secrets).
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const safe = redactSecrets(parsed);
    logger.warn(
      { status: response.status, body: safe },
      "LWA token request failed",
    );
    const errorFields = errorResponseSchema.safeParse(parsed);
    if (errorFields.success) {
      throw new AmazonAuthError(
        errorFields.data.error,
        errorFields.data.error_description,
        { status: response.status },
      );
    }
    throw new AmazonAuthError("token_request_failed", undefined, {
      status: response.status,
      unrecoverable: false,
    });
  }

  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    // Do not log the raw body: a malformed success payload could carry tokens.
    logger.error(
      { status: response.status },
      "LWA token response failed schema validation",
    );
    throw new AmazonAuthError("invalid_token_response", undefined, {
      status: response.status,
      unrecoverable: false,
    });
  }
  return parsed.data;
}

/** Exchange an authorization code for tokens (plan §5 step 3, server-side only). */
export async function exchangeCode(
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  options: OAuthClientOptions = {},
): Promise<TokenSet> {
  const data = await postTokenRequest(
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    },
    options,
  );
  if (!data.refresh_token) {
    // A code exchange without a refresh token cannot bootstrap a connection.
    throw new AmazonAuthError("missing_refresh_token", undefined, {
      unrecoverable: false,
    });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/** Refresh an access token without user involvement (plan §5 step 4). */
export async function refreshAccessToken(
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
  options: OAuthClientOptions = {},
): Promise<TokenSet> {
  const data = await postTokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    },
    options,
  );
  // LWA may omit a new refresh token on refresh; keep the existing one.
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? params.refreshToken,
    expiresIn: data.expires_in,
  };
}
