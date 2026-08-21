import { z } from "zod";
import { addDays, formatIsoDate } from "@amazon-king/optimizer";
import type { IsoDate } from "@amazon-king/contracts";
import { TerminalJobError, type JobHandler } from "../loop.js";
import type { FxRateRow } from "../store.js";
import { isoDateString, type JobDeps } from "./types.js";

/**
 * fx_sync (docs/fx-rates-all-market-plan.md §2): daily top-up of the
 * `fx_rates` table from Frankfurter. Workspace-global — all quotes sit against
 * a single USD pivot (decision 3) and conversion happens at read time, so
 * nothing here is profile-scoped.
 *
 * Stored rows are immutable (ON CONFLICT DO NOTHING), so the `from` parameter
 * makes daily top-up and first-run backfill the same code path: top-up starts
 * the day after the latest stored fixing; the first run covers the oldest
 * stored fact date so historical views convert immediately (plan safety
 * section). A bad upstream payload writes nothing and fails terminally —
 * retrying cannot fix a shape change; HTTP 5xx and network errors stay
 * retryable.
 */

/** First run on a workspace without facts backfills this many days. */
const DEFAULT_BACKFILL_DAYS = 30;

/**
 * Frankfurter v2 `GET /v2/rates?base=USD&from=YYYY-MM-DD` returns a flat
 * array of one row per (date, quote): `[{"date":"2026-08-14","base":"USD",
 * "quote":"EUR","rate":0.86}, ...]` — verified against the live API. Dates may
 * be earlier than requested (weekend/holiday fixings); the stored rows follow
 * the payload's own `date`, never the request window. Unknown additive fields
 * are tolerated (loose object).
 */
const rateRowSchema = z.looseObject({
  date: isoDateString,
  base: z.literal("USD"),
  quote: z.string().regex(/^[A-Z]{3}$/, "expected ISO 4217 currency code"),
  rate: z.number().positive(),
});
const responseSchema = z.array(rateRowSchema);

export function createFxSyncHandler(deps: JobDeps): JobHandler {
  return async (_payload, { logger }) => {
    const now = deps.now();
    const today = formatIsoDate(now.getTime());

    const latest = await deps.store.getLatestFxRateDate();
    let from: string;
    if (latest !== null) {
      from = addDays(latest as IsoDate, 1);
    } else {
      const earliestFact = await deps.store.getEarliestFactDate();
      from = earliestFact ?? addDays(today, -DEFAULT_BACKFILL_DAYS);
    }
    if (from > today) {
      logger.info({ latest }, "FX rates already up to date");
      return;
    }

    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const url = `${deps.config.fxRatesBaseUrl}/v2/rates?base=USD&from=${from}`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      // Transient (5xx / upstream outage): the queue retries with backoff.
      throw new Error(
        `Frankfurter rates request failed: HTTP ${response.status}`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TerminalJobError(
        "Frankfurter rates response was not valid JSON",
      );
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new TerminalJobError(
        `Malformed Frankfurter rates payload: ${parsed.error.message}`,
      );
    }

    const fetchedAt = now.toISOString();
    const rows: FxRateRow[] = parsed.data.map((row) => ({
      rateDate: row.date,
      baseCurrency: "USD",
      quoteCurrency: row.quote,
      // Numeric column, passed as text — never a JS float round trip.
      rate: String(row.rate),
      source: "frankfurter",
      fetchedAt,
    }));
    const inserted = await deps.store.upsertFxRates(rows);
    const coverageThrough = rows.reduce(
      (max, row) => (row.rateDate > max ? row.rateDate : max),
      from,
    );
    logger.info(
      { from, received: rows.length, inserted, coverageThrough },
      "FX rates synced",
    );
  };
}
