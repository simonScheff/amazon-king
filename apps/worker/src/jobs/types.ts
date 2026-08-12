import { z } from "zod";
import type { AmazonAdsGateway, FetchLike } from "@amazon-king/amazon-ads";
import type { WorkerConfig } from "../config.js";
import type { ReportStorage } from "../storage.js";
import type { WorkerStore } from "../store.js";

/** Dependencies every job handler receives; tests substitute fakes. */
export interface JobDeps {
  store: WorkerStore;
  gateway: AmazonAdsGateway;
  storage: ReportStorage;
  config: WorkerConfig;
  /** Injectable clock — handlers never read the wall clock directly. */
  now: () => Date;
  /** Injectable sleep (report polling) so tests run instantly. */
  sleep: (ms: number) => Promise<void>;
  /** Injectable fetch for pre-signed report downloads (never logged). */
  fetch?: FetchLike;
}

export const profilePkSchema = z
  .string()
  .regex(/^\d+$/, "profileId must be the internal profile PK");

export const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
