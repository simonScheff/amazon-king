import { describe, expect, it } from "vitest";
import type { FetchLike } from "@amazon-king/amazon-ads";
import { createFxSyncHandler } from "./fx-sync.js";
import { TerminalJobError } from "../loop.js";
import { FakeStore, makeDeps, runHandler } from "../test-utils.js";
import type { DailyFact } from "../store.js";

// Friday 2026-08-21, after the ECB fixing is published.
const NOW = new Date("2026-08-21T18:00:00.000Z");

function fact(date: string): DailyFact {
  return {
    entityKey: "campaign-1",
    subKey: null,
    campaignAmazonId: "amz-campaign-1",
    date,
    currency: "USD",
    impressions: 100,
    clicks: 10,
    orders: 1,
    units: 1,
    costMicros: 1_000_000,
    salesMicros: 5_000_000,
  };
}

/** Fake fetch recording requested URLs and answering with `body`. */
function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    calls.push(String(input));
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
      },
    );
  };
  return { fetchImpl, calls };
}

function fxDeps(store: FakeStore, fetchImpl: FetchLike) {
  return makeDeps({ store, now: () => NOW, fetch: fetchImpl });
}

describe("fx_sync", () => {
  it("tops up from the day after the latest stored rate date", async () => {
    const store = new FakeStore();
    store.fxRates.push({
      rateDate: "2026-08-19",
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      rate: "0.86",
      source: "frankfurter",
      fetchedAt: "2026-08-19T17:00:00.000Z",
    });
    const { fetchImpl, calls } = fakeFetch([
      { date: "2026-08-20", base: "USD", quote: "EUR", rate: 0.8612 },
      { date: "2026-08-20", base: "USD", quote: "GBP", rate: 0.7415 },
      { date: "2026-08-21", base: "USD", quote: "EUR", rate: 0.8601 },
    ]);
    await runHandler(createFxSyncHandler(fxDeps(store, fetchImpl)), {});

    expect(calls).toEqual([
      "https://api.frankfurter.dev/v2/rates?base=USD&from=2026-08-20",
    ]);
    // Rows are flattened one per (date, quote), rates as strings, clock injected.
    expect(store.fxRates.slice(1)).toEqual([
      {
        rateDate: "2026-08-20",
        baseCurrency: "USD",
        quoteCurrency: "EUR",
        rate: "0.8612",
        source: "frankfurter",
        fetchedAt: NOW.toISOString(),
      },
      {
        rateDate: "2026-08-20",
        baseCurrency: "USD",
        quoteCurrency: "GBP",
        rate: "0.7415",
        source: "frankfurter",
        fetchedAt: NOW.toISOString(),
      },
      {
        rateDate: "2026-08-21",
        baseCurrency: "USD",
        quoteCurrency: "EUR",
        rate: "0.8601",
        source: "frankfurter",
        fetchedAt: NOW.toISOString(),
      },
    ]);
  });

  it("backfills from the earliest fact date on the first run", async () => {
    const store = new FakeStore();
    store.facts.campaign.push(fact("2026-07-15"), fact("2026-08-10"));
    const { fetchImpl, calls } = fakeFetch([
      { date: "2026-07-15", base: "USD", quote: "EUR", rate: 0.85 },
    ]);
    await runHandler(createFxSyncHandler(fxDeps(store, fetchImpl)), {});

    expect(calls).toEqual([
      "https://api.frankfurter.dev/v2/rates?base=USD&from=2026-07-15",
    ]);
    expect(store.fxRates).toHaveLength(1);
  });

  it("falls back to a 30-day window when the workspace has no facts yet", async () => {
    const store = new FakeStore();
    const { fetchImpl, calls } = fakeFetch([]);
    await runHandler(createFxSyncHandler(fxDeps(store, fetchImpl)), {});

    expect(calls).toEqual([
      "https://api.frankfurter.dev/v2/rates?base=USD&from=2026-07-22",
    ]);
  });

  it("upserts only the returned dates when fixings lag the request window", async () => {
    // Weekend request: Friday's fixing is the latest available.
    const store = new FakeStore();
    store.fxRates.push({
      rateDate: "2026-08-14",
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      rate: "0.86",
      source: "frankfurter",
      fetchedAt: "2026-08-14T17:00:00.000Z",
    });
    const weekendNow = new Date("2026-08-16T18:00:00.000Z"); // Sunday
    const { fetchImpl, calls } = fakeFetch([
      // Frankfurter answers with the last business day, earlier than `from`.
      { date: "2026-08-14", base: "USD", quote: "EUR", rate: 0.8604 },
      { date: "2026-08-14", base: "USD", quote: "GBP", rate: 0.7401 },
    ]);
    await runHandler(
      createFxSyncHandler(
        makeDeps({ store, now: () => weekendNow, fetch: fetchImpl }),
      ),
      {},
    );

    expect(calls).toEqual([
      "https://api.frankfurter.dev/v2/rates?base=USD&from=2026-08-15",
    ]);
    // No rows dated after the response's own dates; the already-stored Friday
    // EUR fixing is kept (ON CONFLICT DO NOTHING), only GBP is new.
    expect(store.fxRates).toHaveLength(2);
    expect(store.fxRates[0]!.rate).toBe("0.86");
    expect(store.fxRates[1]).toMatchObject({
      rateDate: "2026-08-14",
      quoteCurrency: "GBP",
    });
  });

  it("fails terminally on a malformed payload and writes nothing", async () => {
    const store = new FakeStore();
    const { fetchImpl } = fakeFetch({ quotes: { EUR: 0.86 } });
    await expect(
      runHandler(createFxSyncHandler(fxDeps(store, fetchImpl)), {}),
    ).rejects.toBeInstanceOf(TerminalJobError);
    expect(store.fxRates).toHaveLength(0);
  });

  it("fails terminally on a non-JSON body", async () => {
    const store = new FakeStore();
    const { fetchImpl } = fakeFetch("<html>cloudflare error</html>");
    await expect(
      runHandler(createFxSyncHandler(fxDeps(store, fetchImpl)), {}),
    ).rejects.toBeInstanceOf(TerminalJobError);
    expect(store.fxRates).toHaveLength(0);
  });

  it("keeps HTTP 5xx retryable (not terminal)", async () => {
    const store = new FakeStore();
    const { fetchImpl } = fakeFetch("upstream error", 502);
    const error = await runHandler(
      createFxSyncHandler(fxDeps(store, fetchImpl)),
      {},
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TerminalJobError);
    expect(store.fxRates).toHaveLength(0);
  });

  it("is a no-op when stored rates already cover today", async () => {
    const store = new FakeStore();
    store.fxRates.push({
      rateDate: "2026-08-21",
      baseCurrency: "USD",
      quoteCurrency: "EUR",
      rate: "0.86",
      source: "frankfurter",
      fetchedAt: "2026-08-21T17:05:00.000Z",
    });
    const { fetchImpl, calls } = fakeFetch([]);
    await runHandler(createFxSyncHandler(fxDeps(store, fetchImpl)), {});

    expect(calls).toEqual([]);
    expect(store.fxRates).toHaveLength(1);
  });
});
