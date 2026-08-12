import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://localhost/amazon_king",
  SESSION_SECRET: "development-session-secret",
  WEB_ORIGIN: "http://localhost:5173",
  LWA_CLIENT_ID: "client-id",
  LWA_CLIENT_SECRET: "client-secret",
  AMAZON_REDIRECT_URI: "http://localhost:3000/api/integrations/amazon/callback",
};

describe("API config", () => {
  it("fails closed on Amazon writes and proxy trust by default", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.killSwitch).toBe(true);
    expect(config.trustProxy).toBe(false);
    expect(config.isDevelopment).toBe(true);
  });

  it("allows the operator to explicitly enable writes", () => {
    expect(loadConfig({ ...BASE_ENV, KILL_SWITCH: "false" }).killSwitch).toBe(
      false,
    );
  });

  it("requires owner, public URL, SMTP, and a strong session secret in production", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: "production",
        SESSION_SECRET: "change-me",
      }),
    ).toThrow();
  });

  it("accepts a complete production single-owner configuration", () => {
    const config = loadConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
      SESSION_SECRET: "a-production-session-secret-that-is-long-enough",
      OWNER_EMAIL: "owner@example.com",
      API_PUBLIC_URL: "https://ads.example.com",
      WEB_ORIGIN: "https://ads.example.com",
      AMAZON_REDIRECT_URI:
        "https://ads.example.com/api/integrations/amazon/callback",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "mailer",
      SMTP_PASSWORD: "secret",
      SMTP_FROM: "amazon-king <no-reply@example.com>",
      TRUST_PROXY: "true",
    });
    expect(config.isDevelopment).toBe(false);
    expect(config.ownerEmail).toBe("owner@example.com");
    expect(config.smtpPort).toBe(587);
    expect(config.trustProxy).toBe(true);
  });

  it("rejects partial SMTP authentication", () => {
    expect(() => loadConfig({ ...BASE_ENV, SMTP_USER: "mailer" })).toThrow(
      /SMTP_USER and SMTP_PASSWORD/,
    );
  });
});
