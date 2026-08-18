/**
 * @amazon-king/optimizer — deterministic, pure optimization engine
 * (docs/plan.md §9–§10). No I/O, no database, no network, no wall clock:
 * time is injected (`now`) so every function is reproducible.
 *
 * Money is integer micro-units internally (see money.ts) and string-encoded
 * decimals at boundaries; ratios (ACoS, ROAS, CVR) are plain numbers.
 */
export * from "./types.js";
export * from "./money.js";
export * from "./dates.js";
export * from "./calc.js";
export * from "./config.js";
export * from "./negatives.js";
export * from "./rules/index.js";
export * from "./rank.js";
export * from "./guardrails.js";
