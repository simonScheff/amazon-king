/**
 * Worker configuration from environment (plan §8/§13). Every tunable has a
 * safe default; only DATABASE_URL is strictly required. LWA credentials are
 * needed for token refresh — the worker boots without them so non-Amazon
 * jobs still run, but any Amazon call will fail until they are set.
 */
export interface WorkerConfig {
  databaseUrl: string;
  reportStorageDir: string;
  logLevel: string;
  /** Global kill switch (plan §10). The MVP worker never writes to Amazon;
   * the flag is wired now so the future apply worker can honor it. */
  killSwitch: boolean;
  lwaClientId: string | null;
  lwaClientSecret: string | null;
  /** Queue polling interval when no job is available. */
  pollIntervalMs: number;
  /** Queue lease per claimed job; heartbeats extend it. */
  leaseSeconds: number;
  heartbeatMs: number;
  reapIntervalMs: number;
  /** Report status polling: first delay, max delay, overall timeout. */
  reportPollInitialDelayMs: number;
  reportPollMaxDelayMs: number;
  reportPollTimeoutMs: number;
  /** Days re-imported by recent_window_resync (attribution lag, plan §8). */
  recentWindowDays: number;
  /** Recommendation runs skip when the last complete metrics sync is older. */
  recommendationFreshnessHours: number;
  /** schedule_tick self-rescheduling interval (plan §8 cadence). */
  scheduleTickMs: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive number, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the worker");
  }
  return {
    databaseUrl,
    reportStorageDir: env.REPORT_STORAGE_DIR ?? "./.data/reports",
    logLevel: env.LOG_LEVEL ?? "info",
    killSwitch: env.KILL_SWITCH === "true",
    lwaClientId: env.LWA_CLIENT_ID || null,
    lwaClientSecret: env.LWA_CLIENT_SECRET || null,
    pollIntervalMs: intEnv("WORKER_POLL_INTERVAL_MS", 2_000),
    leaseSeconds: intEnv("WORKER_LEASE_SECONDS", 120),
    heartbeatMs: intEnv("WORKER_HEARTBEAT_MS", 30_000),
    reapIntervalMs: intEnv("WORKER_REAP_INTERVAL_MS", 60_000),
    reportPollInitialDelayMs: intEnv("REPORT_POLL_INITIAL_DELAY_MS", 5_000),
    reportPollMaxDelayMs: intEnv("REPORT_POLL_MAX_DELAY_MS", 60_000),
    reportPollTimeoutMs: intEnv("REPORT_POLL_TIMEOUT_MS", 20 * 60_000),
    recentWindowDays: intEnv("RECENT_WINDOW_DAYS", 14),
    recommendationFreshnessHours: intEnv("RECOMMENDATION_FRESHNESS_HOURS", 48),
    scheduleTickMs: intEnv("SCHEDULE_TICK_MS", 15 * 60_000),
  };
}
