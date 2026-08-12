import { createGunzip } from "node:zlib";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import { z } from "zod";
import { isoDateSchema } from "@amazon-king/contracts";
import { parseWith } from "../validate.js";
import type { AdsHttpClient, AdsRequestContext } from "../http.js";
import { defaultLogger, type LoggerLike } from "../logger.js";
import { AmazonApiError } from "../errors.js";
import type { FetchLike } from "../oauth.js";
import type {
  ReportJob,
  ReportSpec,
  ReportState,
  ReportStatus,
  SpReportTypeId,
} from "../types.js";

/**
 * Reporting v3 adapter (plan §6): create → poll → download. Only stable
 * Sponsored Products report types are supported; no beta endpoints.
 */

const DEFAULT_GROUP_BY: Record<SpReportTypeId, string[]> = {
  spCampaigns: ["campaign"],
  spSearchTerm: ["searchTerm"],
  spTargeting: ["targeting"],
  spAdvertisedProduct: ["asin"],
};

const DEFAULT_DIMENSIONS: Record<SpReportTypeId, string[]> = {
  spCampaigns: ["campaignId", "campaignName"],
  spSearchTerm: ["campaignId", "adGroupId", "searchTerm"],
  spTargeting: ["campaignId", "adGroupId", "targetingId", "targetingText"],
  spAdvertisedProduct: [
    "campaignId",
    "adGroupId",
    "advertisedSku",
    "advertisedAsin",
  ],
};

export const reportSpecSchema = z.object({
  reportType: z.enum([
    "spCampaigns",
    "spSearchTerm",
    "spTargeting",
    "spAdvertisedProduct",
  ]),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  metrics: z.array(z.string().min(1)).min(1),
  groupBy: z.array(z.string().min(1)).optional(),
});

/** Translate an internal ReportSpec into a Reporting v3 create body. */
export function buildReportRequestBody(
  spec: ReportSpec,
): Record<string, unknown> {
  const parsed = parseWith(reportSpecSchema, spec, "report spec");
  return {
    name: `amazon-king ${parsed.reportType} ${parsed.startDate}..${parsed.endDate}`,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    configuration: {
      adProduct: "SPONSORED_PRODUCTS",
      groupBy: parsed.groupBy ?? DEFAULT_GROUP_BY[parsed.reportType],
      columns: [...DEFAULT_DIMENSIONS[parsed.reportType], ...parsed.metrics],
      reportTypeId: parsed.reportType,
      timeUnit: "DAILY",
      format: "GZIP_JSON",
    },
  };
}

const createReportResponseSchema = z.looseObject({
  reportId: z.string().min(1),
  status: z.string().optional(),
});

const reportStatusResponseSchema = z.looseObject({
  reportId: z.string().min(1),
  status: z.enum(["PENDING", "IN_PROGRESS", "SUCCESS", "FAILURE"]),
  url: z.string().optional(),
  failureReason: z.string().optional(),
});

const AMAZON_STATE_MAP: Record<
  "PENDING" | "IN_PROGRESS" | "SUCCESS" | "FAILURE",
  ReportState
> = {
  PENDING: "queued",
  IN_PROGRESS: "polling",
  // Data is ready; the download/decompress/validate phase starts next.
  SUCCESS: "downloading",
  FAILURE: "failed",
};

/** POST /reporting/reports — returns a job handle; the data is never in this response. */
export async function requestReport(
  http: AdsHttpClient,
  context: AdsRequestContext & { profileId: string },
  spec: ReportSpec,
  now: () => string = () => new Date().toISOString(),
): Promise<ReportJob> {
  const response = await http.request({
    method: "POST",
    path: "/reporting/reports",
    context,
    body: buildReportRequestBody(spec),
  });
  const data = parseWith(
    createReportResponseSchema,
    response.data,
    "POST /reporting/reports",
  );
  return {
    reportId: data.reportId,
    profileId: context.profileId,
    reportType: spec.reportType,
    state: "queued",
    requestedAt: now(),
  };
}

/** GET /reporting/reports/{reportId} — map Amazon's status onto the internal state machine. */
export async function getReportStatus(
  http: AdsHttpClient,
  context: AdsRequestContext & { profileId: string },
  reportId: string,
): Promise<ReportStatus> {
  const response = await http.request({
    method: "GET",
    path: `/reporting/reports/${encodeURIComponent(reportId)}`,
    context,
  });
  const data = parseWith(
    reportStatusResponseSchema,
    response.data,
    `GET /reporting/reports/${reportId}`,
  );
  const status: ReportStatus = {
    reportId: data.reportId,
    state: AMAZON_STATE_MAP[data.status],
    amazonStatus: data.status,
    failureReason: data.failureReason,
  };
  if (data.status === "SUCCESS") {
    if (!data.url) {
      throw new AmazonApiError(
        "Report is SUCCESS but Amazon returned no download URL",
        { status: response.status, requestId: response.requestId },
      );
    }
    status.downloadUrl = data.url;
  }
  return status;
}

export interface DownloadReportOptions {
  fetch?: FetchLike;
  logger?: LoggerLike;
  /** Set false when the artifact is not gzipped (default true: GZIP_JSON). */
  compressed?: boolean;
}

/**
 * Stream a completed report's pre-signed URL into a sink, decompressing on
 * the fly — never buffered fully in memory (plan §8 import mechanics step 6).
 * The URL is sensitive and must never be logged.
 */
export async function downloadReport(
  url: string,
  sink: Writable,
  options: DownloadReportOptions = {},
): Promise<{ bytesWritten: number }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? defaultLogger();
  const compressed = options.compressed ?? true;

  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    logger.warn(
      { status: response.status },
      "Report download failed (URL redacted)",
    );
    throw new AmazonApiError(
      `Report download failed with status ${response.status}`,
      { status: response.status, retryable: response.status >= 500 },
    );
  }

  let bytesWritten = 0;
  // Count decompressed bytes as they flow through so reconciliation can check sizes.
  const counter = new PassThrough();
  counter.on("data", (chunk: Buffer) => {
    bytesWritten += chunk.length;
  });
  const source = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );
  // Spread defeats pipeline()'s overloads; type it loosely here.
  const runPipeline = pipeline as (...streams: unknown[]) => Promise<void>;
  await runPipeline(
    source,
    ...(compressed ? [createGunzip()] : []),
    counter,
    sink,
  );
  logger.info({ bytesWritten, compressed }, "Report downloaded (URL redacted)");
  return { bytesWritten };
}
