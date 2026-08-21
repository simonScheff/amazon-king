import { z } from "zod";
import { currencyCodeSchema } from "./common.js";

/**
 * Workspace settings (docs/fx-rates-all-market-plan.md, decision 5).
 * `displayCurrency` selects the currency of the all-market dashboard view; it
 * never rewrites stored facts, which keep their native marketplace currency.
 */
export const workspaceSettingsSchema = z.object({
  displayCurrency: currencyCodeSchema,
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

/** PATCH /api/workspace/settings body. */
export const workspaceSettingsUpdateSchema = z.object({
  displayCurrency: currencyCodeSchema,
});
export type WorkspaceSettingsUpdate = z.infer<
  typeof workspaceSettingsUpdateSchema
>;
