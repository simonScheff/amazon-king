import { z } from "zod";
import type { Logger } from "pino";
import {
  AdapterValidationError,
  AmazonAuthError,
  downloadReport,
  parseReportRows,
} from "@amazon-king/amazon-ads";
import type { ReportStatus } from "@amazon-king/amazon-ads";
import { TerminalJobError, type JobHandler } from "../loop.js";
import { isoDateString, profilePkSchema, type JobDeps } from "./types.js";
import {
  buildAllFamilySpecs,
  REPORT_FAMILIES,
  type FamilySpec,
} from "../report-specs.js";
import { mapRowsToFacts, reconcileFacts } from "../reconcile.js";
import type { ProfileRecord, ReportJobRecord } from "../store.js";

/**
 * metrics_sync — the Reporting v3 orchestration (plan §8): for each of the
 * four SP report families, build a deterministic spec, dedupe by fingerprint,
 * request → poll (with persisted amazon_report_id so restarts resume at
 * polling via the gateway reportOwner callback) → download streaming to
 * REPORT_STORAGE_DIR → validate → reconcile → batch upsert in a transaction.
 * The encompassing sync_run completes only when all four families pass, and
 * a successful run chains a recommendation_run.
 */

/** Max times a single report job is re-driven before it is dead-lettered. */
const MAX_REPORT_ATTEMPTS = 5;

const payloadSchema = z.looseObject({
  profileId: profilePkSchema,
  startDate: isoDateString,
  endDate: isoDateString,
});

export function createMetricsSyncHandler(deps: JobDeps): JobHandler {
  return async (payload, { logger }) => {
    const { profileId, startDate, endDate } = payloadSchema.parse(payload);
    if (endDate < startDate) {
      throw new TerminalJobError(`Invalid date range ${startDate}..${endDate}`);
    }
    const profile = await deps.store.getProfile(profileId);
    if (!profile) {
      throw new TerminalJobError(`Unknown profile ${profileId}`);
    }
    if (!profile.enabled) {
      logger.info({ profileId }, "Profile disabled; skipping metrics sync");
      return;
    }

    const syncRunId = await deps.store.createSyncRun(profileId, "metrics");
    const familySpecs = buildAllFamilySpecs(profile.id, startDate, endDate);
    let completed = false;
    try {
      for (const familySpec of familySpecs) {
        await driveFamily(deps, profile, syncRunId, familySpec, logger);
      }
      // The encompassing sync run completes only when every family passed
      // (plan §8 step 12). Verified via the deterministic fingerprints so
      // adopted/resumed report jobs count too.
      const statuses = await Promise.all(
        familySpecs.map(async (familySpec) => {
          const job = await deps.store.findReportJobByFingerprint(
            familySpec.specFingerprint,
          );
          return job?.status ?? "missing";
        }),
      );
      if (!statuses.every((status) => status === "complete")) {
        throw new Error(
          `Metrics sync incomplete: families ${REPORT_FAMILIES.join(",")} ended as ${statuses.join(",")}`,
        );
      }
      await deps.store.finishSyncRun(syncRunId, "complete");
      completed = true;
      // Chain: recommendations are generated after a successful complete
      // metrics import (plan §8 cadence), never from partial data.
      await deps.store.enqueueIfNotQueued("recommendation_run", {
        profileId: profile.id,
      });
      logger.info({ profileId, startDate, endDate }, "Metrics sync completed");
    } catch (error) {
      if (!completed) {
        await deps.store.finishSyncRun(
          syncRunId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  };
}

async function driveFamily(
  deps: JobDeps,
  profile: ProfileRecord,
  syncRunId: string,
  familySpec: FamilySpec,
  logger: Logger,
): Promise<void> {
  const { family, spec, specFingerprint } = familySpec;
  let job = await deps.store.findReportJobByFingerprint(specFingerprint);

  // Dedupe (plan §8 step 2): an already complete spec is never requested twice.
  if (job?.status === "complete") {
    logger.info(
      { family, specFingerprint },
      "Report already complete; skipping",
    );
    return;
  }
  job ??= await deps.store.createReportJob({
    syncRunId,
    profileId: profile.id,
    reportType: family,
    specFingerprint,
    dateStart: spec.startDate,
    dateEnd: spec.endDate,
  });

  if (job.status === "failed" || job.status === "dead_letter") {
    if (job.attempts >= MAX_REPORT_ATTEMPTS) {
      await deps.store.updateReportJob(job.id, { status: "dead_letter" });
      throw new TerminalJobError(
        `Report ${family} exhausted ${MAX_REPORT_ATTEMPTS} attempts: ${job.error ?? "unknown error"}`,
      );
    }
    await deps.store.updateReportJob(job.id, {
      status: "retryable",
      incrementAttempts: true,
    });
    job = { ...job, status: "retryable" };
  }

  // Request phase. States queued/requested/retryable (re)request a fresh
  // Amazon report; polling/downloading/validating/importing resume using the
  // persisted amazon_report_id (restart-safe via the reportOwner callback).
  if (
    job.status === "queued" ||
    job.status === "requested" ||
    job.status === "retryable" ||
    !job.amazonReportId
  ) {
    await deps.store.updateReportJob(job.id, { status: "requested" });
    let handle;
    try {
      handle = await deps.gateway.requestReport(profile.id, spec);
    } catch (error) {
      throw await translateAmazonError(deps, profile, job, error);
    }
    await deps.store.updateReportJob(job.id, {
      status: "polling",
      amazonReportId: handle.reportId,
    });
    job = { ...job, amazonReportId: handle.reportId };
  }

  const status = await pollUntilReady(deps, profile, job);
  if (!status.downloadUrl) {
    await deps.store.updateReportJob(job.id, {
      status: "failed",
      error: "Amazon reported SUCCESS without a download URL",
    });
    throw new TerminalJobError(
      `Report ${family} completed without a download URL`,
    );
  }

  // Download streaming to local artifact storage (gzip kept as-is).
  await deps.store.updateReportJob(job.id, { status: "downloading" });
  const storageKey = `${profile.workspaceId}/${profile.id}/${job.amazonReportId}.json.gz`;
  const artifact = await deps.storage.store(storageKey, async (sink) => {
    await downloadReport(status.downloadUrl as string, sink, {
      compressed: false,
      fetch: deps.fetch,
    });
  });
  await deps.store.updateReportJob(job.id, {
    status: "validating",
    checksum: artifact.checksum,
    storageKey: artifact.key,
  });

  // Validate the artifact read back from storage.
  if (!(await deps.storage.verifyChecksum(artifact.key, artifact.checksum))) {
    await deps.store.updateReportJob(job.id, {
      status: "failed",
      error: "artifact checksum mismatch on read-back",
    });
    throw new TerminalJobError(
      `Report ${family} artifact failed integrity check`,
    );
  }
  let rows;
  try {
    rows = parseReportRows(
      family,
      await deps.storage.readGzipJson(artifact.key),
    );
  } catch (error) {
    if (error instanceof AdapterValidationError) {
      await deps.store.updateReportJob(job.id, {
        status: "failed",
        error: error.message,
      });
      throw new TerminalJobError(error.message);
    }
    throw error;
  }

  // Reconcile before import (plan §8 step 11).
  const facts = mapRowsToFacts(family, rows, profile.id, profile.currencyCode);
  const reconciliation = reconcileFacts(facts, {
    expectedRowCount: rows.length,
    dateStart: spec.startDate,
    dateEnd: spec.endDate,
    currency: profile.currencyCode,
  });
  if (!reconciliation.ok) {
    const summary = reconciliation.issues
      .slice(0, 5)
      .map((issue) => issue.message)
      .join("; ");
    await deps.store.updateReportJob(job.id, {
      status: "failed",
      error: `reconciliation failed (${reconciliation.issues.length} issues): ${summary}`,
    });
    throw new TerminalJobError(
      `Report ${family} reconciliation failed: ${summary}`,
    );
  }

  // Import atomically; only then is the report complete (plan §8 step 10–12).
  await deps.store.updateReportJob(job.id, { status: "importing" });
  const imported = await deps.store.importMetrics(facts);
  await deps.store.updateReportJob(job.id, { status: "complete" });
  logger.info(
    { family, rows: rows.length, imported, storageKey: artifact.key },
    "Report imported",
  );
}

/** Poll with increasing delay until Amazon completes the report (plan §8 step 4). */
async function pollUntilReady(
  deps: JobDeps,
  profile: ProfileRecord,
  job: ReportJobRecord,
): Promise<ReportStatus> {
  const deadline = deps.now().getTime() + deps.config.reportPollTimeoutMs;
  let delay = deps.config.reportPollInitialDelayMs;
  for (;;) {
    await deps.sleep(delay);
    let status: ReportStatus;
    try {
      status = await deps.gateway.getReport(job.amazonReportId as string);
    } catch (error) {
      throw await translateAmazonError(deps, profile, job, error);
    }
    if (status.state === "downloading") {
      return status;
    }
    if (status.state === "failed") {
      // Amazon terminally failed this report; mark retryable so the queue
      // retry requests a fresh one (the old report id is superseded).
      await deps.store.updateReportJob(job.id, {
        status: "retryable",
        error: status.failureReason ?? "Amazon report failed",
        incrementAttempts: true,
      });
      throw new Error(
        `Amazon report ${job.amazonReportId} failed: ${status.failureReason ?? "unknown"}`,
      );
    }
    await deps.store.updateReportJob(job.id, { status: "polling" });
    if (deps.now().getTime() >= deadline) {
      await deps.store.updateReportJob(job.id, {
        status: "retryable",
        error: "report polling timed out",
        incrementAttempts: true,
      });
      throw new Error(`Report ${job.amazonReportId} polling timed out`);
    }
    delay = Math.min(delay * 2, deps.config.reportPollMaxDelayMs);
  }
}

/** Dead grants dead-letter the queue job; everything else stays retryable. */
async function translateAmazonError(
  deps: JobDeps,
  profile: ProfileRecord,
  job: ReportJobRecord,
  error: unknown,
): Promise<Error> {
  if (error instanceof AmazonAuthError && error.unrecoverable) {
    await deps.store.markConnectionReconnectRequired(
      profile.connectionId,
      error.code,
    );
    await deps.store.updateReportJob(job.id, {
      status: "failed",
      error: `authentication failed: ${error.code}`,
    });
    return new TerminalJobError(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
