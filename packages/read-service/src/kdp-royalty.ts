import { createHash } from "node:crypto";
import type {
  KdpRoyaltyApplyInput,
  KdpRoyaltyApplyResult,
  KdpRoyaltyImport,
  KdpRoyaltyImportInput,
  KdpRoyaltyImportSummary,
  KdpRoyaltyRow,
  KdpRoyaltySkippedRow,
  KdpRoyaltySuggestion,
} from "@amazon-king/contracts";
import {
  audit,
  books,
  kdpRoyaltyImports,
  kdpSales,
  profiles,
  type Db,
} from "@amazon-king/database";
import { conflict, notFound } from "./errors.js";
import { isoDate, isoDateTime } from "./serialize.js";
import type { AuthContext, RequestMeta } from "./types.js";

/**
 * KDP royalty import (docs/kdp-royalty-import-plan.md): derive royalty-per-copy
 * suggestions from an uploaded Royalties Estimator workbook and, on explicit
 * apply, write them into effective-dated book_economics. KDP data has no ad
 * attribution — suggestions are monthly per-book/per-market recalibrations,
 * never per-day or per-campaign figures.
 */

export interface KdpRoyaltyDeps {
  db: Db;
  now?: () => Date;
}

/** KDP marketplace strings → ISO country, for profile matching. */
const KDP_MARKETPLACE_COUNTRIES: Record<string, string> = {
  "Amazon.com": "US",
  "Amazon.co.uk": "GB",
  "Amazon.de": "DE",
  "Amazon.fr": "FR",
  "Amazon.it": "IT",
  "Amazon.es": "ES",
  "Amazon.nl": "NL",
  "Amazon.co.jp": "JP",
  "Amazon.ca": "CA",
  "Amazon.com.au": "AU",
  "Amazon.in": "IN",
  "Amazon.pl": "PL",
  "Amazon.se": "SE",
  "Amazon.com.br": "BR",
  "Amazon.com.mx": "MX",
  "Amazon.com.tr": "TR",
  "Amazon.ae": "AE",
  "Amazon.sa": "SA",
  "Amazon.sg": "SG",
};

/** Royalty rates that only occur off-Amazon (expanded distribution, etc.). */
const NON_STANDARD_ROYALTY_TYPES = new Set(["40%", "50%"]);

/**
 * The Amazon Ads API reports the United Kingdom profile with country code
 * "UK" while ISO 3166 (and KDP_MARKETPLACE_COUNTRIES) use "GB" — without this
 * alias a real UK profile looks like "no ads profile" for Amazon.co.uk rows.
 */
const PROFILE_COUNTRY_ALIASES: Record<string, string> = { GB: "UK" };

/** Below this many standard units a suggestion is advisory-only by default. */
const LOW_EVIDENCE_UNITS = 5;
/** Deviation from the current value that flags a suggestion for review. */
const DEVIATION_WARNING_RATIO = 0.15;

function isStandardRow(row: KdpRoyaltyRow): boolean {
  return (
    !NON_STANDARD_ROYALTY_TYPES.has(row.royaltyType) &&
    !row.transactionType.toLowerCase().startsWith("expanded distribution")
  );
}

/**
 * Stable serialization of the row set, so the same workbook always hashes to
 * the same fingerprint regardless of upload order.
 */
function payloadFingerprint(input: KdpRoyaltyImportInput): string {
  const rows = input.rows
    .map((row) =>
      JSON.stringify([
        row.format,
        row.orderDate,
        row.royaltyDate,
        row.asin,
        row.title,
        row.marketplace,
        row.royaltyType,
        row.transactionType,
        row.netUnits,
        row.royalty,
        row.currency,
      ]),
    )
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** Round to the book_economics column precision, trimming float noise. */
function toDecimalString(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

interface RowGroup {
  marketplace: string;
  asin: string;
  title: string;
  rows: KdpRoyaltyRow[];
}

function groupRows(rows: KdpRoyaltyRow[]): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const key = `${row.marketplace}${row.asin}`;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, {
        marketplace: row.marketplace,
        asin: row.asin,
        title: row.title,
        rows: [row],
      });
    }
  }
  return [...groups.values()];
}

function unitsOf(rows: KdpRoyaltyRow[]): number {
  return rows.reduce((total, row) => total + row.netUnits, 0);
}

/** Case-insensitive lookup key matching linkByProfileAsin's ASIN handling. */
function rowKey(marketplace: string, asin: string): string {
  return `${marketplace} ${asin.toUpperCase()}`;
}

/**
 * Resolve report rows to catalog book × profile pairs via the marketplace →
 * country → profile and ASIN link chain. Rows that resolve keep their
 * book/profile ids on the stored transaction even when their group is later
 * skipped for a suggestion (e.g. currency mismatch). Exported for
 * scripts/rebuild-kdp-history.ts, which replays stored rows through the same
 * resolution.
 */
export function resolveKdpTransactionLinks(
  profileList: profiles.AmazonProfileRow[],
  links: books.WorkspaceBookLink[],
  rows: KdpRoyaltyRow[],
): Map<string, { bookId: string; profilePk: string }> {
  const profileByCountry = new Map(
    profileList.map((profile) => [profile.countryCode, profile]),
  );
  const linkByProfileAsin = new Map(
    links.map((link) => [
      `${link.profilePk} ${link.marketplaceAsin.toUpperCase()}`,
      link,
    ]),
  );
  const resolved = new Map<string, { bookId: string; profilePk: string }>();
  for (const row of rows) {
    const key = rowKey(row.marketplace, row.asin);
    if (resolved.has(key)) {
      continue;
    }
    const countryCode = KDP_MARKETPLACE_COUNTRIES[row.marketplace];
    if (!countryCode) {
      continue;
    }
    const profile =
      profileByCountry.get(countryCode) ??
      (PROFILE_COUNTRY_ALIASES[countryCode]
        ? profileByCountry.get(PROFILE_COUNTRY_ALIASES[countryCode])
        : undefined);
    if (!profile) {
      continue;
    }
    const link = linkByProfileAsin.get(
      `${profile.id} ${row.asin.toUpperCase()}`,
    );
    if (!link) {
      continue;
    }
    resolved.set(key, { bookId: link.bookId, profilePk: profile.id });
  }
  return resolved;
}

/** Verbatim transaction rows for the history table, with resolved links. */
export function toKdpTransactionInputs(
  workspaceId: string,
  importId: string,
  rows: KdpRoyaltyRow[],
  links: Map<string, { bookId: string; profilePk: string }>,
): kdpSales.KdpSaleTransactionInput[] {
  return rows.map((row) => {
    const link = links.get(rowKey(row.marketplace, row.asin));
    return {
      workspaceId,
      importId,
      bookId: link?.bookId ?? null,
      profileId: link?.profilePk ?? null,
      asin: row.asin,
      marketplace: row.marketplace,
      format: row.format,
      royaltyType: row.royaltyType,
      transactionType: row.transactionType,
      orderDate: row.orderDate,
      royaltyDate: row.royaltyDate,
      netUnits: row.netUnits,
      royalty: row.royalty,
      currency: row.currency,
    };
  });
}

export async function createKdpRoyaltyImport(
  deps: KdpRoyaltyDeps,
  auth: AuthContext,
  input: KdpRoyaltyImportInput,
  meta: RequestMeta,
): Promise<KdpRoyaltyImport> {
  const { db } = deps;
  const workspaceId = auth.workspaceId;

  const [profileList, links, economicsList] = await Promise.all([
    profiles.listProfilesByWorkspace(db, workspaceId),
    books.listBookLinksByWorkspace(db, workspaceId),
    books.listLatestBookEconomicsByWorkspace(db, workspaceId),
  ]);
  const profileByCountry = new Map(
    profileList.map((profile) => [profile.countryCode, profile]),
  );
  const linkByProfileAsin = new Map(
    links.map((link) => [
      `${link.profilePk}${link.marketplaceAsin.toUpperCase()}`,
      link,
    ]),
  );
  const economicsByBookProfile = new Map(
    economicsList.map((economics) => [
      `${economics.bookId}${economics.profileId}`,
      economics,
    ]),
  );

  const suggestions: KdpRoyaltySuggestion[] = [];
  const skipped: KdpRoyaltySkippedRow[] = [];
  // Phase-2 history population: verbatim transactions carry the catalog ids
  // whenever the ASIN link resolves — even when the group is later skipped
  // for another reason, like a currency mismatch.
  const transactionLinks = resolveKdpTransactionLinks(
    profileList,
    links,
    input.rows,
  );

  for (const group of groupRows(input.rows)) {
    const skip = (reason: KdpRoyaltySkippedRow["reason"]) =>
      skipped.push({
        asin: group.asin,
        title: group.title,
        marketplace: group.marketplace,
        reason,
        units: unitsOf(group.rows),
      });

    const countryCode = KDP_MARKETPLACE_COUNTRIES[group.marketplace];
    if (!countryCode) {
      skip("unknown_marketplace");
      continue;
    }
    const profile =
      profileByCountry.get(countryCode) ??
      (PROFILE_COUNTRY_ALIASES[countryCode]
        ? profileByCountry.get(PROFILE_COUNTRY_ALIASES[countryCode])
        : undefined);
    if (!profile) {
      skip("no_ads_profile");
      continue;
    }
    const link = linkByProfileAsin.get(
      `${profile.id}${group.asin.toUpperCase()}`,
    );
    if (!link) {
      skip("asin_not_linked");
      continue;
    }
    if (group.rows.some((row) => row.currency !== profile.currencyCode)) {
      skip("currency_mismatch");
      continue;
    }

    const standardRows = group.rows.filter(isStandardRow);
    const expandedRows = group.rows.filter((row) => !isStandardRow(row));
    const standardUnits = unitsOf(standardRows);
    const royaltySum = standardRows.reduce(
      (total, row) => total + Number(row.royalty),
      0,
    );
    if (standardUnits <= 0 || royaltySum < 0) {
      skip("no_standard_rows");
      continue;
    }

    const suggested = royaltySum / standardUnits;
    const current = economicsByBookProfile.get(`${link.bookId}${profile.id}`);
    const currentRoyalty = current?.estimatedRoyaltyPerSale ?? null;
    const currentValue =
      currentRoyalty === null ? null : Number(currentRoyalty);

    suggestions.push({
      bookId: link.bookId,
      profileId: profile.profileId,
      title: link.title,
      countryCode,
      currency: profile.currencyCode,
      currentRoyaltyPerSale: currentRoyalty,
      suggestedRoyaltyPerSale: toDecimalString(suggested),
      standardUnits,
      expandedUnits: unitsOf(expandedRows),
      lowEvidence: standardUnits < LOW_EVIDENCE_UNITS,
      deviationWarning:
        currentValue !== null &&
        currentValue > 0 &&
        Math.abs(suggested - currentValue) / currentValue >
          DEVIATION_WARNING_RATIO,
    });
  }

  const { import: batch, created } =
    await kdpRoyaltyImports.insertKdpRoyaltyImport(db, {
      workspaceId,
      fileName: input.fileName,
      payloadSha256: payloadFingerprint(input),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      rowCount: input.rows.length,
      suggestions,
      skipped,
      rows: input.rows,
    });

  if (created) {
    // Populate the history table. A replayed upload must not re-populate —
    // the batch insert is the idempotency gate. The merge is additive:
    // rows identical to the incoming ones are replaced and everything else
    // is left alone, so an overlapping later file (every KDP file carries a
    // previous-month order tail) can never destroy another import's data.
    await kdpSales.mergeKdpSaleTransactions(
      db,
      toKdpTransactionInputs(
        workspaceId,
        batch.id,
        input.rows,
        transactionLinks,
      ),
    );
  }

  await audit.insertAuditEvent(db, {
    workspaceId,
    actorUserId: auth.userId,
    event: "kdp.royalty_import.create",
    entityType: "kdp_royalty_import",
    entityId: batch.id,
    ip: meta.ip ?? null,
    sessionId: auth.sessionId,
    details: {
      fileName: input.fileName,
      rowCount: input.rows.length,
      suggestionCount: suggestions.length,
      skippedCount: skipped.length,
      replay: !created,
    },
  });

  return {
    id: batch.id,
    fileName: batch.fileName,
    periodStart: isoDate(batch.periodStart),
    periodEnd: isoDate(batch.periodEnd),
    rowCount: batch.rowCount,
    createdAt: isoDateTime(batch.createdAt),
    appliedAt: batch.appliedAt === null ? null : isoDateTime(batch.appliedAt),
    alreadyExisted: !created,
    suggestions: batch.suggestions as KdpRoyaltySuggestion[],
    skipped: batch.skipped as KdpRoyaltySkippedRow[],
  };
}

export async function listKdpRoyaltyImports(
  db: Db,
  workspaceId: string,
): Promise<KdpRoyaltyImportSummary[]> {
  const batches = await kdpRoyaltyImports.listKdpRoyaltyImports(
    db,
    workspaceId,
  );
  return batches.map((batch) => ({
    id: batch.id,
    fileName: batch.fileName,
    periodStart: isoDate(batch.periodStart),
    periodEnd: isoDate(batch.periodEnd),
    rowCount: batch.rowCount,
    suggestionCount: batch.suggestions.length,
    createdAt: isoDateTime(batch.createdAt),
    appliedAt: batch.appliedAt === null ? null : isoDateTime(batch.appliedAt),
  }));
}

/**
 * Apply selected suggestions: each becomes an effective-dated economics row
 * that keeps every other field of the latest economics (decision 6 of the
 * plan — only royalty per sale changes). Books without an existing economics
 * row are skipped, so profit rules stay correctly disabled for them.
 */
export async function applyKdpRoyaltyImport(
  deps: KdpRoyaltyDeps,
  auth: AuthContext,
  importId: string,
  input: KdpRoyaltyApplyInput,
  meta: RequestMeta,
): Promise<KdpRoyaltyApplyResult> {
  const { db } = deps;
  const workspaceId = auth.workspaceId;
  const batch = await kdpRoyaltyImports.getKdpRoyaltyImport(
    db,
    workspaceId,
    importId,
  );
  if (!batch) {
    throw notFound("Unknown KDP royalty import");
  }
  if (batch.appliedAt !== null) {
    throw conflict(
      "KDP_IMPORT_ALREADY_APPLIED",
      "This import has already been applied",
    );
  }

  const suggestions = batch.suggestions as KdpRoyaltySuggestion[];
  const effectiveFrom =
    input.effectiveFrom ??
    (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const skipped: KdpRoyaltyApplyResult["skipped"] = [];
  let applied = 0;

  for (const selection of input.selections) {
    const suggestion = suggestions.find(
      (candidate) =>
        candidate.bookId === selection.bookId &&
        candidate.profileId === selection.profileId,
    );
    const profile = suggestion
      ? await profiles.findProfileByAmazonId(
          db,
          workspaceId,
          selection.profileId,
        )
      : null;
    const book = suggestion ? await books.getBook(db, selection.bookId) : null;
    if (!suggestion || !profile || !book || book.workspaceId !== workspaceId) {
      skipped.push({ ...selection, reason: "unknown_selection" });
      continue;
    }
    const current = await books.getLatestBookEconomics(db, book.id, profile.id);
    if (!current) {
      skipped.push({ ...selection, reason: "no_existing_economics" });
      continue;
    }
    await books.upsertBookEconomics(db, {
      bookId: book.id,
      profileId: profile.id,
      effectiveFrom,
      currency: profile.currencyCode,
      listPrice: current.listPrice,
      estimatedRoyaltyPerSale: suggestion.suggestedRoyaltyPerSale,
      targetAcos: current.targetAcos,
      goalMode: current.goalMode,
      maxSpendWithoutSale: current.maxSpendWithoutSale,
      maxBid: current.maxBid,
      maxDailyBudget: current.maxDailyBudget,
      notes: current.notes,
    });
    await audit.insertAuditEvent(db, {
      workspaceId,
      actorUserId: auth.userId,
      event: "books.economics",
      entityType: "book",
      entityId: book.id,
      ip: meta.ip ?? null,
      sessionId: auth.sessionId,
      details: {
        profileId: selection.profileId,
        effectiveFrom,
        goalMode: current.goalMode,
        source: "kdp_royalty_import",
        importId,
      },
    });
    applied += 1;
  }

  const marked = await kdpRoyaltyImports.markKdpRoyaltyImportApplied(
    db,
    workspaceId,
    importId,
  );
  if (!marked) {
    throw conflict(
      "KDP_IMPORT_ALREADY_APPLIED",
      "This import has already been applied",
    );
  }
  await audit.insertAuditEvent(db, {
    workspaceId,
    actorUserId: auth.userId,
    event: "kdp.royalty_import.apply",
    entityType: "kdp_royalty_import",
    entityId: importId,
    ip: meta.ip ?? null,
    sessionId: auth.sessionId,
    details: { applied, skipped: skipped.length, effectiveFrom },
  });

  return { applied, skipped };
}
