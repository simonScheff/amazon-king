import type { IsoDate, IsoDateTime } from "@amazon-king/contracts";

const MS_PER_DAY = 86_400_000;

/** Parse an ISO calendar date (YYYY-MM-DD) to UTC milliseconds. */
export function parseIsoDate(date: IsoDate): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new TypeError(`Invalid ISO date: ${JSON.stringify(date)}`);
  }
  return ms;
}

/** Format UTC milliseconds as an ISO calendar date. */
export function formatIsoDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10) as IsoDate;
}

/** Add (or subtract) whole days to an ISO date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  return formatIsoDate(parseIsoDate(date) + days * MS_PER_DAY);
}

/** Whole days from `start` to `end` (positive when end is after start). */
export function daysBetween(start: IsoDate, end: IsoDate): number {
  return Math.round((parseIsoDate(end) - parseIsoDate(start)) / MS_PER_DAY);
}

/** Calendar-date part of an ISO timestamp. */
export function dateOfDateTime(dateTime: IsoDateTime): IsoDate {
  return formatIsoDate(Date.parse(dateTime));
}

/** Milliseconds since epoch for an ISO timestamp; throws on invalid input. */
export function parseIsoDateTime(dateTime: IsoDateTime): number {
  const ms = Date.parse(dateTime);
  if (Number.isNaN(ms)) {
    throw new TypeError(`Invalid ISO timestamp: ${JSON.stringify(dateTime)}`);
  }
  return ms;
}
