import { gzipSync } from "node:zlib";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createAmazonAdsGateway,
  type ReportJob,
  type ReportSpec,
  type ReportStatus,
} from "@amazon-king/amazon-ads";
import { createMetricsSyncHandler } from "./metrics-sync.js";
import { buildAllFamilySpecs, buildFamilySpec } from "../report-specs.js";
import { TerminalJobError } from "../loop.js";
import {
  FakeStorage,
  FakeStore,
  fakeGateway,
  makeDeps,
  runHandler,
} from "../test-utils.js";
import type { ProfileRecord } from "../store.js";

const PROFILE: ProfileRecord = {
  id: "7",
  amazonProfileId: "amz-profile-7",
  connectionId: "3",
  workspaceId: "1",
  region: "NA",
  currencyCode: "USD",
  enabled: true,
};

const RANGE = { startDate: "2026-08-01", endDate: "2026-08-05" };

const ROWS_BY_FAMILY: Record<string, unknown[]> = {
  spCampaigns: [
    {
      date: "2026-08-01",
      campaignId: "c1",
      campaignName: "Campaign 1",
      impressions: 100,
      clicks: 10,
      cost: 5.5,
      purchases7d: 2,
      sales7d: 20,
    },
  ],
  spTargeting: [
    {
      date: "2026-08-01",
      campaignId: "c1",
      adGroupId: "ag1",
      keywordId: "t1",
      impressions: 50,
      clicks: 5,
      cost: 2.5,
      purchases7d: 1,
      sales7d: 10,
    },
  ],
  spSearchTerm: [
    {
      date: "2026-08-01",
      campaignId: "c1",
      adGroupId: "ag1",
      keywordId: "t1",
      searchTerm: "coloring book",
      impressions: 30,
      clicks: 3,
      cost: 1.5,
    },
  ],
  spAdvertisedProduct: [
    {
      date: "2026-08-01",
      campaignId: "c1",
      adGroupId: "ag1",
      adId: "ad1",
      advertisedAsin: "B001",
      impressions: 80,
      clicks: 8,
      cost: 4,
    },
  ],
};

function gzipResponse(rows: unknown[]): Response {
  return new Response(gzipSync(JSON.stringify(rows)));
}

interface GatewayCalls {
  requestReport: Mock<
    (profileId: string, spec: ReportSpec) => Promise<ReportJob>
  >;
  getReport: Mock<(reportId: string) => Promise<ReportStatus>>;
}

function makeMetricsDeps(
  store: FakeStore,
  storage: FakeStorage,
  options: {
    rowsByFamily?: Record<string, unknown[]>;
    getReportStatus?: (reportId: string) => ReportStatus;
    now?: () => Date;
  } = {},
): { deps: ReturnType<typeof makeDeps>; calls: GatewayCalls } {
  const rowsByFamily = options.rowsByFamily ?? ROWS_BY_FAMILY;
  let reportSeq = 0;
  const calls: GatewayCalls = {
    requestReport: vi.fn(
      async (profileId: string, spec: ReportSpec): Promise<ReportJob> => {
        reportSeq += 1;
        return {
          reportId: `amz-report-${reportSeq}-${spec.reportType}`,
          profileId,
          reportType: spec.reportType,
          state: "queued",
          requestedAt: new Date().toISOString(),
        };
      },
    ),
    getReport: vi.fn(async (reportId: string): Promise<ReportStatus> => {
      if (options.getReportStatus) return options.getReportStatus(reportId);
      return {
        reportId,
        state: "downloading",
        amazonStatus: "SUCCESS",
        downloadUrl: `https://download.test/${reportId}`,
      };
    }),
  };
  const deps = makeDeps({
    store,
    storage,
    gateway: fakeGateway({
      requestReport: calls.requestReport,
      getReport: calls.getReport,
    }),
    fetch: async (input) => {
      const url = String(input);
      const family = Object.keys(rowsByFamily).find((f) => url.includes(f));
      return gzipResponse(family ? rowsByFamily[family]! : []);
    },
    ...(options.now ? { now: options.now } : {}),
  });
  return { deps, calls };
}

function payload() {
  return { profileId: PROFILE.id, ...RANGE };
}

describe("metrics_sync", () => {
  it("runs all four families end to end and chains a recommendation run", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    const storage = new FakeStorage();
    const { deps } = makeMetricsDeps(store, storage);

    await runHandler(createMetricsSyncHandler(deps), payload());

    // All four report jobs are complete with checksums and storage keys.
    expect(store.reportJobs.size).toBe(4);
    for (const job of store.reportJobs.values()) {
      expect(job.status).toBe("complete");
      expect(job.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(job.storageKey).toBe(`1/7/${job.amazonReportId}.json.gz`);
    }
    // Four artifacts were stored.
    expect(storage.files.size).toBe(4);
    // Four fact batches were imported; the sync run completed.
    expect(store.importCalls).toHaveLength(4);
    const run = store.syncRuns.find((r) => r.kind === "metrics")!;
    expect(run.status).toBe("complete");
    // A successful complete import chains a recommendation run (plan §8).
    expect(
      store.jobs.some(
        (j) =>
          j.type === "recommendation_run" &&
          (j.payload as { profileId: string }).profileId === "7",
      ),
    ).toBe(true);
  });

  it("recovers a previously queued manual job that has no date range", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    const storage = new FakeStorage();
    const { deps, calls } = makeMetricsDeps(store, storage, {
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    await runHandler(createMetricsSyncHandler(deps), {
      profileId: PROFILE.id,
    });

    for (const [, spec] of calls.requestReport.mock.calls) {
      expect(spec.startDate).toBe("2026-07-12");
      expect(spec.endDate).toBe("2026-08-11");
    }
  });

  it("splits a 60-day import into Reporting v3-safe date chunks", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    const storage = new FakeStorage();
    const emptyRows = Object.fromEntries(
      Object.keys(ROWS_BY_FAMILY).map((family) => [family, []]),
    );
    const { deps, calls } = makeMetricsDeps(store, storage, {
      rowsByFamily: emptyRows,
    });

    await runHandler(createMetricsSyncHandler(deps), {
      profileId: PROFILE.id,
      startDate: "2026-06-13",
      endDate: "2026-08-11",
    });

    expect(calls.requestReport).toHaveBeenCalledTimes(8);
    const ranges = new Set(
      calls.requestReport.mock.calls.map(
        ([, spec]) => `${spec.startDate}..${spec.endDate}`,
      ),
    );
    expect(ranges).toEqual(
      new Set(["2026-06-13..2026-07-13", "2026-07-14..2026-08-11"]),
    );
    expect(store.reportJobs.size).toBe(8);
    expect(store.importCalls).toHaveLength(8);
  });

  it("does not re-request a spec whose fingerprint is already complete", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    // Pre-complete the spCampaigns report job.
    const completeSpec = buildFamilySpec(
      "spCampaigns",
      PROFILE.id,
      RANGE.startDate,
      RANGE.endDate,
    );
    store.reportJobs.set(completeSpec.specFingerprint, {
      id: "99",
      syncRunId: "1",
      profileId: PROFILE.id,
      reportType: "spCampaigns",
      specFingerprint: completeSpec.specFingerprint,
      amazonReportId: "amz-old",
      status: "complete",
      attempts: 1,
      checksum: "abc",
      storageKey: "1/7/amz-old.json.gz",
      error: null,
    });
    const storage = new FakeStorage();
    const { deps, calls } = makeMetricsDeps(store, storage);

    await runHandler(createMetricsSyncHandler(deps), payload());

    const requestedTypes = calls.requestReport.mock.calls.map(
      (call) => (call[1] as { reportType: string }).reportType,
    );
    expect(requestedTypes).not.toContain("spCampaigns");
    expect(requestedTypes.sort()).toEqual(
      ["spAdvertisedProduct", "spSearchTerm", "spTargeting"].sort(),
    );
    expect(store.importCalls).toHaveLength(3);
  });

  it("resumes at polling after a restart when amazon_report_id is persisted", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    // Simulate a crash mid-poll: report jobs exist with amazon_report_id set.
    for (const familySpec of buildAllFamilySpecs(
      PROFILE.id,
      RANGE.startDate,
      RANGE.endDate,
    )) {
      store.reportJobs.set(familySpec.specFingerprint, {
        id: `job-${familySpec.family}`,
        syncRunId: "1",
        profileId: PROFILE.id,
        reportType: familySpec.family,
        specFingerprint: familySpec.specFingerprint,
        amazonReportId: `amz-report-1-${familySpec.family}`,
        status: "polling",
        attempts: 1,
        checksum: null,
        storageKey: null,
        error: null,
      });
    }
    const storage = new FakeStorage();
    const { deps, calls } = makeMetricsDeps(store, storage);

    await runHandler(createMetricsSyncHandler(deps), payload());

    // No new reports were requested; polling resumed from the persisted ids.
    expect(calls.requestReport).not.toHaveBeenCalled();
    expect(calls.getReport).toHaveBeenCalledTimes(4);
    expect(store.importCalls).toHaveLength(4);
    expect(store.syncRuns.find((r) => r.kind === "metrics")!.status).toBe(
      "complete",
    );
  });

  it("resolves the owning profile of a resumed report via the reportOwner callback", async () => {
    // Exercises the real gateway wiring used after a worker restart.
    const httpRequest = vi.fn(async (_request: unknown) => ({
      status: 200,
      data: { reportId: "amz-1", status: "PENDING" },
      requestId: "req-1",
    }));
    const gateway = createAmazonAdsGateway({
      clientId: "client",
      tokenManager: { getAccessToken: async () => "token" },
      profileDirectory: {
        get: async (profilePk: string) => ({
          profileId: `amz-profile-${profilePk}`,
          connectionId: "3",
          region: "NA",
          accountId: null,
        }),
      },
      reportOwner: async (reportId: string) =>
        reportId === "amz-1" ? "7" : null,
      http: { request: httpRequest },
    });
    const status = await gateway.getReport("amz-1");
    expect(status.state).toBe("queued");
    const context = (
      httpRequest.mock.calls[0]![0] as { context: { profileId?: string } }
    ).context;
    expect(context.profileId).toBe("amz-profile-7");
  });

  it("marks the report failed and the sync incomplete on reconciliation failure", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    const badRows = {
      ...ROWS_BY_FAMILY,
      spCampaigns: [
        {
          date: "2026-08-01",
          campaignId: "c1",
          campaignName: "Campaign 1",
          impressions: 100,
          clicks: 3,
          cost: 5.5,
          purchases7d: -2, // attribution extras fail reconciliation
        },
      ],
    };
    const storage = new FakeStorage();
    const { deps } = makeMetricsDeps(store, storage, { rowsByFamily: badRows });

    await expect(
      runHandler(createMetricsSyncHandler(deps), payload()),
    ).rejects.toBeInstanceOf(TerminalJobError);

    const campaignSpec = buildFamilySpec(
      "spCampaigns",
      PROFILE.id,
      RANGE.startDate,
      RANGE.endDate,
    );
    const campaignJob = store.reportJobs.get(campaignSpec.specFingerprint)!;
    expect(campaignJob.status).toBe("failed");
    expect(campaignJob.error).toContain("reconciliation failed");
    // Nothing was imported and the sync run did not complete.
    expect(store.importCalls).toHaveLength(0);
    expect(store.syncRuns.find((r) => r.kind === "metrics")!.status).toBe(
      "failed",
    );
  });

  it("converges to a single final state when the same rows are imported twice", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    const storage = new FakeStorage();
    const { deps } = makeMetricsDeps(store, storage);

    await runHandler(createMetricsSyncHandler(deps), payload());
    const totalRows = Object.values(ROWS_BY_FAMILY).reduce(
      (sum, rows) => sum + rows.length,
      0,
    );
    expect(store.convergedFacts.size).toBe(totalRows);

    // Simulate a crash after import but before marking complete: reset the
    // report jobs and re-run the whole sync — the same rows are re-imported.
    for (const [fp, job] of store.reportJobs) {
      store.reportJobs.set(fp, {
        ...job,
        status: "queued",
        amazonReportId: null,
      });
    }
    await runHandler(createMetricsSyncHandler(deps), payload());

    expect(store.importCalls).toHaveLength(8); // 4 families x 2 runs
    expect(store.convergedFacts.size).toBe(totalRows); // still one row per grain
  });

  it("marks polling reports retryable and lets the queue retry them", async () => {
    const store = new FakeStore();
    store.profiles.push(PROFILE);
    const storage = new FakeStorage();
    const { deps } = makeMetricsDeps(store, storage, {
      getReportStatus: (reportId) => ({
        reportId,
        state: "failed",
        amazonStatus: "FAILURE",
        failureReason: "INTERNAL_ERROR",
      }),
    });

    // Not a TerminalJobError: the queue retries with backoff (plan §8).
    await expect(
      runHandler(createMetricsSyncHandler(deps), payload()),
    ).rejects.not.toBeInstanceOf(TerminalJobError);
    const spec = buildFamilySpec(
      "spCampaigns",
      PROFILE.id,
      RANGE.startDate,
      RANGE.endDate,
    );
    expect(store.reportJobs.get(spec.specFingerprint)!.status).toBe(
      "retryable",
    );
    expect(store.importCalls).toHaveLength(0);
  });
});
