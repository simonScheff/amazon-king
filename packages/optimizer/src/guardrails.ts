import type { IsoDate, IsoDateTime } from "@amazon-king/contracts";
import { dateOfDateTime, daysBetween, parseIsoDateTime } from "./dates.js";
import type { RecentChange } from "./types.js";

/**
 * Pure guardrail checkers (docs/plan.md §10). These run before any write is
 * sent to Amazon; they never mutate anything and never touch I/O. Every
 * check returns structured violations so the API can block and explain.
 */

export interface GuardrailConfig {
  /** Max |after - before| / before per bid action within a cooldown period. */
  maxBidChangePct: number;
  /** A target that changed within this many days cannot be changed again. */
  bidCooldownDays: number;
  /** Absolute daily-budget ceiling; null disables the check. */
  maxDailyBudgetMicros: number | null;
  /** Max single budget increase as a fraction of the current budget. */
  maxBudgetIncreasePct: number;
  /** Max actions in one change set. */
  maxActionsPerChangeSet: number;
  /** Max summed monetary exposure per change set; null disables the check. */
  maxExposureMicros: number | null;
  /** Evidence older than this many days refuses the write. */
  stalenessDays: number;
  /** Lower-cased terms that may never receive a negative. */
  protectedSearchTerms: string[];
  /** Campaigns that may never be modified. */
  protectedCampaignIds: string[];
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  maxBidChangePct: 0.15,
  bidCooldownDays: 7,
  maxDailyBudgetMicros: null,
  maxBudgetIncreasePct: 0.25,
  maxActionsPerChangeSet: 20,
  maxExposureMicros: null,
  stalenessDays: 3,
  protectedSearchTerms: [],
  protectedCampaignIds: [],
};

export interface GuardrailAction {
  actionType:
    | "update_bid"
    | "add_negative_exact"
    | "remove_negative_exact"
    | "update_budget";
  targetId?: string | null;
  campaignId?: string | null;
  searchTerm?: string | null;
  /** Before/after money in micros where applicable (bid, budget). */
  beforeMicros?: number | null;
  afterMicros?: number | null;
  /** End date of the evidence the action is based on. */
  evidenceEnd: IsoDate;
}

export interface GuardrailInput {
  /** Global kill switch: when true, every write is disabled immediately. */
  killSwitch: boolean;
  /** Per-profile write flag; read-only is the default (false → block). */
  writeEnabled: boolean;
  /** Injected clock. */
  now: IsoDateTime;
  actions: GuardrailAction[];
  recentChanges?: RecentChange[];
  config?: Partial<GuardrailConfig>;
}

export type GuardrailViolationCode =
  | "KILL_SWITCH_ENABLED"
  | "PROFILE_READ_ONLY"
  | "BID_CHANGE_TOO_LARGE"
  | "BID_COOLDOWN_ACTIVE"
  | "BUDGET_EXCEEDS_MAX"
  | "BUDGET_INCREASE_TOO_LARGE"
  | "TOO_MANY_ACTIONS"
  | "EXPOSURE_TOO_LARGE"
  | "PROTECTED_ENTITY"
  | "STALE_EVIDENCE";

export interface GuardrailViolation {
  code: GuardrailViolationCode;
  message: string;
}

export interface GuardrailResult {
  allowed: boolean;
  violations: GuardrailViolation[];
}

const MS_PER_DAY = 86_400_000;

/** Check one change set against every guardrail; collect all violations. */
export function checkGuardrails(input: GuardrailInput): GuardrailResult {
  const config: GuardrailConfig = {
    ...DEFAULT_GUARDRAIL_CONFIG,
    ...input.config,
  };
  const violations: GuardrailViolation[] = [];
  const recentChanges = input.recentChanges ?? [];

  if (input.killSwitch) {
    violations.push({
      code: "KILL_SWITCH_ENABLED",
      message: "The global kill switch is enabled; all writes are disabled.",
    });
  }
  if (!input.writeEnabled) {
    violations.push({
      code: "PROFILE_READ_ONLY",
      message:
        "This profile is read-only; enable writes before applying changes.",
    });
  }
  if (input.actions.length > config.maxActionsPerChangeSet) {
    violations.push({
      code: "TOO_MANY_ACTIONS",
      message:
        `Change set has ${input.actions.length} actions; the maximum per ` +
        `change set is ${config.maxActionsPerChangeSet}.`,
    });
  }

  let exposureMicros = 0;
  const nowDate = dateOfDateTime(input.now);
  const bidCooldownCutoff =
    parseIsoDateTime(input.now) - config.bidCooldownDays * MS_PER_DAY;

  for (const action of input.actions) {
    if (daysBetween(action.evidenceEnd, nowDate) > config.stalenessDays) {
      violations.push({
        code: "STALE_EVIDENCE",
        message:
          `Evidence for a ${action.actionType} action ends on ` +
          `${action.evidenceEnd}, older than the ${config.stalenessDays}-day ` +
          `freshness limit. Re-sync before writing.`,
      });
    }

    if (
      action.campaignId != null &&
      config.protectedCampaignIds.includes(action.campaignId)
    ) {
      violations.push({
        code: "PROTECTED_ENTITY",
        message: `Campaign ${action.campaignId} is protected and cannot be changed.`,
      });
    }

    switch (action.actionType) {
      case "add_negative_exact": {
        const term = (action.searchTerm ?? "").trim().toLowerCase();
        if (
          term !== "" &&
          config.protectedSearchTerms.some(
            (protectedTerm) => protectedTerm.trim().toLowerCase() === term,
          )
        ) {
          violations.push({
            code: "PROTECTED_ENTITY",
            message:
              `Search term "${action.searchTerm}" is protected and cannot be ` +
              `added as a negative.`,
          });
        }
        break;
      }
      case "remove_negative_exact":
        // A rollback removes a negative; protected-term checks apply only
        // when creating the exclusion. Campaign protection still applies.
        break;
      case "update_bid": {
        const before = action.beforeMicros ?? null;
        const after = action.afterMicros ?? null;
        if (before !== null && before > 0 && after !== null) {
          exposureMicros += Math.abs(after - before);
          const changePct = Math.abs(after - before) / before;
          if (changePct > config.maxBidChangePct) {
            violations.push({
              code: "BID_CHANGE_TOO_LARGE",
              message:
                `Bid change on target ${action.targetId ?? "unknown"} is ` +
                `${(changePct * 100).toFixed(1)}%, above the ` +
                `${(config.maxBidChangePct * 100).toFixed(0)}% per-cooldown maximum.`,
            });
          }
        }
        const targetId = action.targetId ?? null;
        const changedRecently = recentChanges.some(
          (change) =>
            change.actionType === "update_bid" &&
            change.targetId === targetId &&
            parseIsoDateTime(change.changedAt) >= bidCooldownCutoff,
        );
        if (changedRecently) {
          violations.push({
            code: "BID_COOLDOWN_ACTIVE",
            message:
              `Target ${targetId ?? "unknown"} already changed within the ` +
              `${config.bidCooldownDays}-day cooldown; only one adjustment per ` +
              `cooldown period is allowed.`,
          });
        }
        break;
      }
      case "update_budget": {
        const before = action.beforeMicros ?? null;
        const after = action.afterMicros ?? null;
        if (after !== null) {
          if (before !== null && after > before) {
            exposureMicros += after - before;
          }
          if (
            config.maxDailyBudgetMicros !== null &&
            after > config.maxDailyBudgetMicros
          ) {
            violations.push({
              code: "BUDGET_EXCEEDS_MAX",
              message:
                `Proposed daily budget exceeds the configured maximum for ` +
                `campaign ${action.campaignId ?? "unknown"}.`,
            });
          }
          if (before !== null && before > 0 && after > before) {
            const increasePct = (after - before) / before;
            if (increasePct > config.maxBudgetIncreasePct) {
              violations.push({
                code: "BUDGET_INCREASE_TOO_LARGE",
                message:
                  `Budget increase on campaign ${action.campaignId ?? "unknown"} ` +
                  `is ${(increasePct * 100).toFixed(1)}%, above the ` +
                  `${(config.maxBudgetIncreasePct * 100).toFixed(0)}% single-increase maximum.`,
              });
            }
          }
        }
        break;
      }
    }
  }

  if (
    config.maxExposureMicros !== null &&
    exposureMicros > config.maxExposureMicros
  ) {
    violations.push({
      code: "EXPOSURE_TOO_LARGE",
      message:
        `Total monetary exposure of the change set exceeds the configured ` +
        `maximum per change set.`,
    });
  }

  return { allowed: violations.length === 0, violations };
}
