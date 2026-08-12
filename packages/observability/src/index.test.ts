import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";
import {
  REDACT_CENSOR,
  createLogger,
  redactSecrets,
  withRequestId,
} from "./index.js";

describe("redactSecrets", () => {
  it("masks tokens, codes, and client secrets at any depth", () => {
    const input = {
      profileId: "prf_1",
      oauth: {
        access_token: "Atza|secret",
        refreshToken: "Atzr|secret",
        nested: { client_secret: "lwa-secret", code: "auth-code" },
      },
    };
    const redacted = redactSecrets(input) as Record<string, never>;
    expect(redacted.profileId).toBe("prf_1");
    const oauth = redacted.oauth as Record<string, unknown>;
    expect(oauth.access_token).toBe(REDACT_CENSOR);
    expect(oauth.refreshToken).toBe(REDACT_CENSOR);
    expect((oauth.nested as Record<string, unknown>).client_secret).toBe(
      REDACT_CENSOR,
    );
    expect((oauth.nested as Record<string, unknown>).code).toBe(REDACT_CENSOR);
  });

  it("masks pre-signed report URLs", () => {
    const input = {
      report: {
        status: "SUCCESS",
        url: "https://offline-report-storage-prod.s3.amazonaws.com/xyz?X-Amz-Signature=abc",
        downloadUrl: "https://s3.example.com/report.gz?sig=1",
        presignedUrl: "https://s3.example.com/other.gz?sig=2",
      },
    };
    const report = (redactSecrets(input) as { report: Record<string, unknown> })
      .report;
    expect(report.status).toBe("SUCCESS");
    expect(report.url).toBe(REDACT_CENSOR);
    expect(report.downloadUrl).toBe(REDACT_CENSOR);
    expect(report.presignedUrl).toBe(REDACT_CENSOR);
  });

  it("leaves normal fields untouched and handles arrays", () => {
    const input = {
      campaigns: [
        { campaignId: "cmp_1", bid: "0.45" },
        { campaignId: "cmp_2", token: "x" },
      ],
      count: 2,
      ok: true,
    };
    const redacted = redactSecrets(input) as {
      campaigns: Array<Record<string, unknown>>;
      count: number;
      ok: boolean;
    };
    expect(redacted.campaigns[0]).toEqual({ campaignId: "cmp_1", bid: "0.45" });
    expect(redacted.campaigns[1].token).toBe(REDACT_CENSOR);
    expect(redacted.count).toBe(2);
    expect(redacted.ok).toBe(true);
  });

  it("does not mutate the input object", () => {
    const input = { token: "secret", keep: 1 };
    redactSecrets(input);
    expect(input.token).toBe("secret");
  });

  it("passes through primitives", () => {
    expect(redactSecrets("hello")).toBe("hello");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
  });
});

describe("createLogger", () => {
  it("returns a pino logger that censors sensitive paths", () => {
    const lines: string[] = [];
    const stream: DestinationStream = {
      write: (chunk: string) => void lines.push(chunk),
    };
    const logger = createLogger("test", {}, stream);
    logger.info({ accessToken: "Atza|secret", profileId: "prf_1" }, "hello");
    const output = lines.join("");
    expect(output).not.toContain("Atza|secret");
    expect(output).toContain(REDACT_CENSOR);
    expect(output).toContain("prf_1");
  });
});

describe("withRequestId", () => {
  it("generates a uuid when none is given", () => {
    expect(withRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("passes through an existing id", () => {
    expect(withRequestId("req_123")).toBe("req_123");
  });
});
