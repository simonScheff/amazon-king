import { z } from "zod";

/**
 * Runtime configuration for the API server, parsed from environment
 * variables (plan §13: secrets come from the deployment environment, never
 * from code or per-user storage).
 */

const configSchema = z.object({
  nodeEnv: z.string().default("development"),
  port: z.number().int().positive().default(3000),
  databaseUrl: z.url(),
  /** HMAC secret for stateless CSRF tokens derived from the session. */
  sessionSecret: z.string().min(16),
  webOrigin: z.url(),
  lwaClientId: z.string().min(1),
  lwaClientSecret: z.string().min(1),
  amazonRedirectUri: z.url(),
  /** Global kill switch: disables every Amazon write immediately (§10). */
  killSwitch: z.boolean().default(false),
  /** When set, only this email may sign in (single-owner lock). */
  ownerEmail: z.string().email().optional(),
  /** Base URL the magic link points at (the API itself; verify redirects to the web app). */
  apiPublicUrl: z.url().optional(),
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
    killSwitch: env.KILL_SWITCH === "true",
    ownerEmail: env.OWNER_EMAIL || undefined,
    apiPublicUrl: env.API_PUBLIC_URL || undefined,
  });
  return { ...parsed, isDevelopment: parsed.nodeEnv !== "production" };
}
