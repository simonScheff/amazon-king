import { z } from "zod";

/**
 * Runtime configuration for the API server, parsed from environment
 * variables (plan §13: secrets come from the deployment environment, never
 * from code or per-user storage).
 */

const configSchema = z
  .object({
    nodeEnv: z
      .enum(["development", "test", "production"])
      .default("development"),
    port: z.number().int().positive().default(3000),
    databaseUrl: z.url(),
    /** HMAC secret for stateless CSRF tokens derived from the session. */
    sessionSecret: z.string().min(16),
    webOrigin: z.url(),
    lwaClientId: z.string().min(1),
    lwaClientSecret: z.string().min(1),
    amazonRedirectUri: z.url(),
    /** Global kill switch: disables every Amazon write immediately (§10). */
    killSwitch: z.boolean().default(true),
    /** Whether Fastify should trust forwarding headers from a reverse proxy. */
    trustProxy: z.boolean().default(false),
    /** When set, only this email may sign in (single-owner lock). */
    ownerEmail: z.string().email().optional(),
    /** Base URL the magic link points at (the API itself; verify redirects to the web app). */
    apiPublicUrl: z.url().optional(),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    smtpSecure: z.boolean().default(false),
    smtpUser: z.string().min(1).optional(),
    smtpPassword: z.string().min(1).optional(),
    smtpFrom: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.smtpUser === undefined) !== (value.smtpPassword === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "SMTP_USER and SMTP_PASSWORD must be set together",
        path: [value.smtpUser === undefined ? "smtpUser" : "smtpPassword"],
      });
    }
    if (value.nodeEnv !== "production") return;
    if (!value.ownerEmail) {
      ctx.addIssue({
        code: "custom",
        message: "OWNER_EMAIL is required in production single-owner mode",
        path: ["ownerEmail"],
      });
    }
    if (!value.apiPublicUrl) {
      ctx.addIssue({
        code: "custom",
        message: "API_PUBLIC_URL is required in production",
        path: ["apiPublicUrl"],
      });
    }
    if (!value.smtpHost) {
      ctx.addIssue({
        code: "custom",
        message: "SMTP_HOST is required in production",
        path: ["smtpHost"],
      });
    }
    if (!value.smtpFrom) {
      ctx.addIssue({
        code: "custom",
        message: "SMTP_FROM is required in production",
        path: ["smtpFrom"],
      });
    }
    if (
      value.sessionSecret.length < 32 ||
      /change-me/i.test(value.sessionSecret)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "SESSION_SECRET must be at least 32 characters and non-default in production",
        path: ["sessionSecret"],
      });
    }
  });

export type ApiConfig = z.infer<typeof configSchema> & {
  /** true outside production (relaxes the Secure cookie flag for http dev). */
  isDevelopment: boolean;
};

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ~7 days, rolling
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Spend-changing actions require authentication this recent (plan §13). */
export const RECENT_AUTH_MS = 15 * 60 * 1000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = configSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT ? Number(env.PORT) : undefined,
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    webOrigin: env.WEB_ORIGIN,
    lwaClientId: env.LWA_CLIENT_ID,
    lwaClientSecret: env.LWA_CLIENT_SECRET,
    amazonRedirectUri: env.AMAZON_REDIRECT_URI,
    killSwitch:
      env.KILL_SWITCH === undefined ? undefined : env.KILL_SWITCH !== "false",
    trustProxy: env.TRUST_PROXY === "true",
    ownerEmail: env.OWNER_EMAIL || undefined,
    apiPublicUrl: env.API_PUBLIC_URL || undefined,
    smtpHost: env.SMTP_HOST || undefined,
    smtpPort: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
    smtpSecure: env.SMTP_SECURE === "true",
    smtpUser: env.SMTP_USER || undefined,
    smtpPassword: env.SMTP_PASSWORD || undefined,
    smtpFrom: env.SMTP_FROM || undefined,
  });
  return { ...parsed, isDevelopment: parsed.nodeEnv !== "production" };
}
