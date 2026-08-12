/**
 * Pure backoff computation for queue retries and report polling.
 * Kept free of any pg imports so it is unit-testable without a database.
 */

export interface BackoffOptions {
  /** Base delay in ms for the first retry. Default 1000. */
  baseMs?: number;
  /** Hard ceiling for the delay. Default 5 minutes. */
  maxMs?: number;
}

/** Exponential delay (no jitter): base * 2^attempt, clamped to maxMs. */
export function computeBackoffMs(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const { baseMs = 1000, maxMs = 300_000 } = options;
  if (attempt < 0) {
    throw new RangeError("attempt must be >= 0");
  }
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

/**
 * Exponential backoff with full jitter (plan §8): a uniform random value in
 * [0, computeBackoffMs(attempt)]. rng is injectable for deterministic tests.
 */
export function computeBackoffMsWithJitter(
  attempt: number,
  options: BackoffOptions = {},
  rng: () => number = Math.random,
): number {
  return Math.floor(rng() * (computeBackoffMs(attempt, options) + 1));
}
