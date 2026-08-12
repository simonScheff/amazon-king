import { z } from "zod";
import { isoDateTimeSchema } from "./common.js";

export const auditEventSchema = z.object({
  id: z.string(),
  actor: z.string(),
  event: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  details: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
