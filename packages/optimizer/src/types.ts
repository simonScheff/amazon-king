import type { IsoDate, IsoDateTime } from "@amazon-king/contracts";

/**
 * Aggregated metrics over an evidence window. Money is always integer
 * micro-units (see money.ts); counts are plain integers.
 */
export interface WindowMetrics {
  impressions: number;
  clicks: number;
  orders: number;
  costMicros: number;
  salesMicros: number;
}

/** A write action that already happened; used for cooldown suppression. */
export interface RecentChange {
  actionType: "update_bid" | "add_negative_exact";
  targetId: string | null;
  campaignId: string | null;
  searchTerm: string | null;
  changedAt: IsoDateTime;
}

/** Inclusive evidence window over daily fact rows. */
export interface EvidenceWindow {
  start: IsoDate;
  end: IsoDate;
}
