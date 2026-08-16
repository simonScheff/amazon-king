import { z } from "zod";
import { isoDateTimeSchema } from "./common.js";

/** Login A (app sign-in) request: passwordless email flow start. */
export const loginRequestSchema = z.object({
  email: z.string().email(),
  /**
   * Optional same-origin path to land on after verify (e.g. the page that
   * triggered a re-auth). Relative paths only — the regex blocks
   * protocol-relative (`//host`) and backslash variants, so the post-verify
   * redirect can never leave the allowlisted web origin.
   */
  next: z
    .string()
    .regex(/^\/[^/\\]/)
    .max(500)
    .optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Session info exposed to the client for the signed-in owner. */
export const sessionInfoSchema = z.object({
  userId: z.string(),
  workspaceId: z.string(),
  email: z.string().email(),
  expiresAt: isoDateTimeSchema,
  /** Per-session CSRF token the browser must echo as x-csrf-token on mutations. */
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
