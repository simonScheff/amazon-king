import { z } from "zod";
import { isoDateTimeSchema } from "./common.js";

/** Login A (app sign-in) request: passwordless email flow start. */
export const loginRequestSchema = z.object({
  email: z.string().email(),
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
