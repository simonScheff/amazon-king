import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

const queue = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  heartbeat: vi.fn(),
  reapExpiredLeases: vi.fn(),
}));

vi.mock("@amazon-king/database", () => queue);

const { runWorkerLoop } = await import("./loop.js");

function silentLogger(): Logger {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return logger as unknown as Logger;
}

describe("runWorkerLoop", () => {
  it("keeps reaping expired leases while a long job occupies the loop", async () => {
    queue.claim.mockReset();
    queue.reapExpiredLeases.mockReset();
    queue.heartbeat.mockResolvedValue(true);
    queue.complete.mockResolvedValue(undefined);
    queue.reapExpiredLeases.mockResolvedValue([]);
    queue.claim
      .mockResolvedValueOnce({
        id: "1",
        type: "slow",
        payload: {},
        attempts: 0,
      })
      .mockResolvedValue(null);

    let releaseJob = (): void => undefined;
    const jobFinished = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });

    let stopping = false;
    const loop = runWorkerLoop(
      {
        pool: {} as never,
        workerId: "worker-1",
        handlers: { slow: () => jobFinished },
        leaseSeconds: 120,
        heartbeatMs: 10_000,
        pollIntervalMs: 1,
        reapIntervalMs: 2,
        logger: silentLogger(),
      },
      () => stopping,
    );

    // A metrics_sync can hold the loop for hours, so reaping has to continue on
    // its own timer — otherwise a crashed worker's jobs stay `running`.
    await vi.waitFor(() =>
      expect(queue.reapExpiredLeases.mock.calls.length).toBeGreaterThan(2),
    );
    expect(queue.complete).not.toHaveBeenCalled();

    releaseJob();
    stopping = true;
    await loop;
    expect(queue.complete).toHaveBeenCalledTimes(1);
  });

  it("reaps once before claiming so a restarted worker reclaims its orphans", async () => {
    queue.claim.mockReset();
    queue.reapExpiredLeases.mockReset();
    queue.reapExpiredLeases.mockResolvedValue(["7"]);
    queue.claim.mockImplementation(async () => {
      // The up-front reap must already have run by the first claim.
      expect(queue.reapExpiredLeases).toHaveBeenCalled();
      stopping = true;
      return null;
    });

    let stopping = false;
    await runWorkerLoop(
      {
        pool: {} as never,
        workerId: "worker-1",
        handlers: { slow: async () => undefined },
        leaseSeconds: 120,
        heartbeatMs: 10_000,
        pollIntervalMs: 1,
        reapIntervalMs: 60_000,
        logger: silentLogger(),
      },
      () => stopping,
    );

    expect(queue.reapExpiredLeases).toHaveBeenCalledTimes(1);
  });
});
