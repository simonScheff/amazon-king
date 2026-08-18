import { z } from "zod";
import type { Logger } from "pino";
import type { IsoDate } from "@amazon-king/contracts";
import { addDays, formatIsoDate } from "@amazon-king/optimizer";
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
/** Compatibility range for manual jobs queued before date fields were added. */
const LEGACY_MANUAL_SYNC_HISTORY_DAYS = 31;
/** Reporting v3 rejects larger date ranges. Count is inclusive. */
const MAX_REPORT_RANGE_DAYS = 31;

const payloadSchema = z.looseObject({
  profileId: profilePkSchema,
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
});

export function createMetricsSyncHandler(deps: JobDeps): JobHandler {
  return async (payload, { logger }) => {
    const parsed = payloadSchema.parse(payload);
    const { profileId } = parsed;
    let { startDate, endDate } = parsed;
    if ((startDate === undefined) !== (endDate === undefined)) {
      throw new TerminalJobError(
        "Metrics sync payload must include both startDate and endDate",
      );
    }
    if (startDate === undefined || endDate === undefined) {
      const today = formatIsoDate(deps.now().getTime()) as IsoDate;
      endDate = addDays(today, -1);
      startDate = addDays(endDate, -(LEGACY_MANUAL_SYNC_HISTORY_DAYS - 1));
      logger.warn(
        { profileId, startDate, endDate },
        "Legacy metrics sync payload had no date range; using trailing 31 complete UTC days",
      );
    }
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
    // A manual import needs 60 days for the longest optimizer evidence window,
    // while Amazon accepts at most 31 inclusive days per Reporting v3 request.
    // Split inside one queue job so recommendations run only after every chunk
    // and report family has imported successfully.
    const dateChunks = splitReportDateRange(
      startDate as IsoDate,
      endDate as IsoDate,
    );
    const chunkSpecs = dateChunks.map((chunk) =>
      buildAllFamilySpecs(profile.id, chunk.startDate, chunk.endDate),
    );
    const familySpecs = chunkSpecs.flat();
    let completed = false;
    try {
      for (const specs of chunkSpecs) {
        await driveChunk(deps, profile, syncRunId, specs, logger);
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
          `Metrics sync incomplete: ${familySpecs.length} report chunks for families ${REPORT_FAMILIES.join(",")} ended as ${statuses.join(",")}`,
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

export function splitReportDateRange(
  startDate: IsoDate,
  endDate: IsoDate,
): Array<{ startDate: IsoDate; endDate: IsoDate }> {
  const chunks: Array<{ startDate: IsoDate; endDate: IsoDate }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const maximumEnd = addDays(cursor, MAX_REPORT_RANGE_DAYS - 1);
    const chunkEnd = maximumEnd < endDate ? maximumEnd : endDate;
    chunks.push({ startDate: cursor, endDate: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

/**
 * Drive one date chunk's report families together. Each family spends nearly
 * all of its wall time asleep in the poll loop waiting on Amazon, which
 * generates the four reports independently anyway, so awaiting them one at a
 * time multiplied the sync duration by four while the worker's single job slot
 * sat idle. Chunks stay sequential, which caps in-flight reports per profile at
 * the four families no matter how long the requested range is.
 */
async function driveChunk(
  deps: JobDeps,
  profile: ProfileRecord,
  syncRunId: string,
  familySpecs: readonly FamilySpec[],
  logger: Logger,
): Promise<void> {
  const results = await Promise.allSettled(
    familySpecs.map((familySpec) =>
      driveFamily(deps, profile, syncRunId, familySpec, logger),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length === 0) return;
  // Every family recorded its own report_job state before rejecting, so the
  // next attempt resumes each one where it stopped. A terminal failure cannot
  // heal by retrying the queue job, so it outranks transient siblings.
  const message = failures
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("; ");
  throw failures.some((error) => error instanceof TerminalJobError)
    ? new TerminalJobError(message)
    : new Error(message);
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

  // A previous attempt already downloaded the gzip. Re-import from disk
  // instead of re-polling Amazon — the pre-signed URL is usually gone, and
  // the local artifact is the source of truth after validating.
  if (
    (job.status === "validating" || job.status === "importing") &&
    job.storageKey &&
    job.checksum
  ) {
    await importArtifact(
      deps,
      profile,
      job,
      family,
      spec,
      job.storageKey,
      job.checksum,
      logger,
    );
    return;
  }

  // Request phase. queued/requested/retryable (re)request a fresh Amazon
  // report; polling/downloading resume from the persisted amazon_report_id.
  // A report that outlived MAX_REPORT_ATTEMPTS polling windows is treated as
  // abandoned so a wedged report id cannot be resumed forever.
  if (
    job.status === "queued" ||
    job.status === "requested" ||
    job.status === "retryable" ||
    job.attempts >= MAX_REPORT_ATTEMPTS ||
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
  await importArtifact(
    deps,
    profile,
    job,
    family,
    spec,
    artifact.key,
    artifact.checksum,
    logger,
  );
}

/** Validate, reconcile, and upsert a report already stored on disk. */
async function importArtifact(
  deps: JobDeps,
  profile: ProfileRecord,
  job: ReportJobRecord,
  family: FamilySpec["family"],
  spec: FamilySpec["spec"],
  storageKey: string,
  checksum: string,
  logger: Logger,
): Promise<void> {
  if (!(await deps.storage.verifyChecksum(storageKey, checksum))) {
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
    rows = parseReportRows(family, await deps.storage.readGzipJson(storageKey));
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

  await deps.store.updateReportJob(job.id, { status: "importing" });
  const imported = await deps.store.importMetrics(facts);
  await deps.store.updateReportJob(job.id, { status: "complete" });
  logger.info(
    { family, rows: rows.length, imported, storageKey },
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
      // Stay in `polling` and keep amazon_report_id: the report is still being
      // generated, so the queue retry resumes this same report instead of
      // discarding the wait and requesting an identical one.
      await deps.store.updateReportJob(job.id, {
        status: "polling",
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
