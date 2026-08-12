import { describe, expect, it } from "vitest";
import {
  ADS_SCOPE,
  AUTHORIZATION_URL,
  TOKEN_URL,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
} from "../src/oauth.js";
import { AmazonAuthError } from "../src/errors.js";
import { captureLogs, jsonResponse, mockFetch } from "./helpers.js";

const SECRET = "lwa-client-secret-xyz";
const CODE = "auth-code-abc";
const ACCESS = "Atza|access-token-value";
const REFRESH = "Atzr|refresh-token-value";

describe("buildAuthorizationUrl", () => {
  it("builds the LWA consent URL with the ads scope and no secret material", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "lwa-client-id",
        redirectUri: "https://ads.example.com/api/integrations/amazon/callback",
        state: "random-state-128-bits",
      }),
    );
    expect(url.origin + url.pathname).toBe(AUTHORIZATION_URL);
    expect(url.searchParams.get("client_id")).toBe("lwa-client-id");
    expect(url.searchParams.get("scope")).toBe(ADS_SCOPE);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://ads.example.com/api/integrations/amazon/callback",
    );
    expect(url.searchParams.get("state")).toBe("random-state-128-bits");
    expect(url.toString()).not.toContain("secret");
  });
});

describe("exchangeCode", () => {
  it("posts the authorization_code grant form to the LWA token endpoint", async () => {
    const logs = captureLogs();
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        access_token: ACCESS,
        refresh_token: REFRESH,
        token_type: "bearer",
        expires_in: 3600,
      }),
    );
    const tokens = await exchangeCode(
      {
        code: CODE,
        clientId: "lwa-client-id",
        clientSecret: SECRET,
        redirectUri: "https://ads.example.com/callback",
      },
      { fetch, logger: logs.logger },
    );

    expect(tokens).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresIn: 3600,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(TOKEN_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = call.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE);
    expect(form.get("redirect_uri")).toBe("https://ads.example.com/callback");
    expect(form.get("client_id")).toBe("lwa-client-id");
    expect(form.get("client_secret")).toBe(SECRET);
  });

  it("fails when the exchange response has no refresh token", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ access_token: ACCESS, expires_in: 3600 }),
    );
    await expect(
      exchangeCode(
        {
          code: CODE,
          clientId: "id",
          clientSecret: SECRET,
          redirectUri: "https://x/callback",
        },
        { fetch, logger: captureLogs().logger },
      ),
    ).rejects.toMatchObject({
      name: "AmazonAuthError",
      code: "missing_refresh_token",
    });
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh_token grant form", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        access_token: ACCESS,
        refresh_token: "Atzr|rotated",
        expires_in: 3600,
      }),
    );
    const tokens = await refreshAccessToken(
      { refreshToken: REFRESH, clientId: "id", clientSecret: SECRET },
      { fetch, logger: captureLogs().logger },
    );
    const form = calls[0].body as URLSearchParams;
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH);
    expect(form.get("client_secret")).toBe(SECRET);
    expect(tokens.refreshToken).toBe("Atzr|rotated");
  });

  it("keeps the existing refresh token when LWA omits a new one", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ access_token: ACCESS, expires_in: 3600 }),
    );
    const tokens = await refreshAccessToken(
      { refreshToken: REFRESH, clientId: "id", clientSecret: SECRET },
      { fetch, logger: captureLogs().logger },
    );
    expect(tokens.refreshToken).toBe(REFRESH);
  });
});

describe("OAuth errors", () => {
  it("classifies invalid_grant as unrecoverable (reconnect_required)", async () => {
    const logs = captureLogs();
    const { fetch } = mockFetch(() =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "The authorization grant is revoked",
        },
        { status: 400 },
      ),
    );
    const error = await refreshAccessToken(
      { refreshToken: REFRESH, clientId: "id", clientSecret: SECRET },
      { fetch, logger: logs.logger },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAuthError);
    const authError = error as AmazonAuthError;
    expect(authError.code).toBe("invalid_grant");
    expect(authError.unrecoverable).toBe(true);
  });

  it("treats transient failures as recoverable", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ error: "server_error" }, { status: 500 }),
    );
    const error = await refreshAccessToken(
      { refreshToken: REFRESH, clientId: "id", clientSecret: SECRET },
      { fetch, logger: captureLogs().logger },
    ).catch((e: unknown) => e);
    expect((error as AmazonAuthError).unrecoverable).toBe(false);
  });

  it("never leaks secrets, codes, or tokens into logs or error messages", async () => {
    const logs = captureLogs();
    const { fetch } = mockFetch(() =>
      jsonResponse(
        {
          error: "invalid_client",
          error_description: "Client authentication failed",
        },
        { status: 401 },
      ),
    );
    const error = await exchangeCode(
      {
        code: CODE,
        clientId: "id",
        clientSecret: SECRET,
        redirectUri: "https://x/callback",
      },
      { fetch, logger: logs.logger },
    ).catch((e: unknown) => e);

    for (const value of [SECRET, CODE, ACCESS, REFRESH]) {
      expect(logs.text()).not.toContain(value);
      expect((error as Error).message).not.toContain(value);
    }
  });
});
