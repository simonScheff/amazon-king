import { randomUUID } from "node:crypto";
import {
  pino,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export const REDACT_CENSOR = "[REDACTED]";

/**
 * Keys that must never reach logs or error tracking: OAuth tokens and codes,
 * client secrets, authorization headers, and pre-signed report download URLs.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "access_token",
  "refresh_token",
  "accesstoken",
  "refreshtoken",
  "client_secret",
  "clientsecret",
  "code",
  "token",
  "url",
  "downloadurl",
  "presignedurl",
]);

/** Sensitive field names, redacted both at the log line's top level and one level deep. */
const SENSITIVE_FIELD_NAMES = [
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "client_secret",
  "clientSecret",
  "code",
  "token",
  "url",
  "downloadUrl",
  "presignedUrl",
];

/** Pino redact paths covering these keys at the top level and one level deep. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "res.headers.authorization",
  ...SENSITIVE_FIELD_NAMES,
  ...SENSITIVE_FIELD_NAMES.map((key) => `*.${key}`),
];

/**
 * Create a named pino logger. Level comes from LOG_LEVEL (default "info").
 * Sensitive fields are censored with "[REDACTED]".
 */
export function createLogger(
  name: string,
  options: LoggerOptions = {},
  stream?: DestinationStream,
): Logger {
  const { redact, base, level, ...rest } = options;
  const extraPaths =
    typeof redact === "object" && !Array.isArray(redact) ? redact.paths : [];
  return pino(
    {
      level: level ?? process.env.LOG_LEVEL ?? "info",
      base: { name, ...base },
      redact: {
        paths: [...REDACT_PATHS, ...extraPaths],
        censor: REDACT_CENSOR,
      },
      ...rest,
    },
    stream,
  );
}

/**
 * Deep-clone an arbitrary value with every sensitive key masked.
 * Use before handing unknown payloads (Amazon API errors, request bodies)
 * to logs or error tracking.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? REDACT_CENSOR
        : redactSecrets(child);
    }
    return clone;
  }
  return value;
}

/** Generate (or pass through) a uuid request id for log correlation. */
export function withRequestId(requestId?: string): string {
  return requestId ?? randomUUID();
}
