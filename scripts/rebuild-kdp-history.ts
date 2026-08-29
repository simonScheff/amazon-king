/**
 * Rebuild the KDP sales history (kdp_sale_transactions) from the normalized
 * report rows stored on each kdp_royalty_imports batch (migration 0022), so a
 * damaged or stale history can be reconstructed without the original xlsx
 * files. Imports are additive (mergeKdpSaleTransactions), so the rebuild is a
 * deterministic wipe + replay of every stored batch, oldest first; monthly
 * aggregates and the sales mix are derived from the transactions at read
 * time and need no rebuilding themselves.
 *
 * Batches imported before the rows column existed carry no payload — they
 * are listed at the end and become rebuildable only by re-uploading the file.
 *
 * Run from the repo root:
 *
 *   set -a; source .env; set +a; pnpm exec tsx scripts/rebuild-kdp-history.ts
 */
import {
  books,
  createPool,
  identity,
  kdpRoyaltyImports,
  kdpSales,
  profiles,
} from "@amazon-king/database";
// Not root dependencies — resolve the sources via their package paths.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { kdpRoyaltyRowSchema } from "../packages/contracts/src/kdp.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {
  resolveKdpTransactionLinks,
  toKdpTransactionInputs,
} from "../packages/read-service/src/kdp-royalty.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set (copy .env.example to .env first)");
  process.exit(1);
}
if (!/\/amazon_king(\?|$)/.test(databaseUrl)) {
  console.error("Refusing to run: DATABASE_URL is not the dev amazon_king DB");
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  const workspaceId = await identity.getSingleWorkspaceId(pool);
  if (!workspaceId) {
    console.error("No workspace found — sign in to the dashboard once first");
    process.exit(1);
  }

  const [batches, profileList, linkList] = await Promise.all([
    kdpRoyaltyImports.listKdpRoyaltyImportPayloads(pool, workspaceId),
    profiles.listProfilesByWorkspace(pool, workspaceId),
    books.listBookLinksByWorkspace(pool, workspaceId),
  ]);
  const replayable = batches.filter((batch) => batch.rows.length > 0);
  const missing = batches.filter((batch) => batch.rows.length === 0);
  if (replayable.length === 0) {
    console.error(
      "No import batch has stored rows to replay — re-upload a KDP report first",
    );
    process.exit(1);
  }

  const wiped = await pool.query(
    `delete from kdp_sale_transactions where workspace_id = $1`,
    [workspaceId],
  );

  let replayed = 0;
  for (const batch of replayable) {
    const rows = kdpRoyaltyRowSchema.array().parse(batch.rows);
    const links = resolveKdpTransactionLinks(profileList, linkList, rows);
    await kdpSales.mergeKdpSaleTransactions(
      pool,
      toKdpTransactionInputs(workspaceId, batch.id, rows, links),
    );
    replayed += rows.length;
    console.log(
      `replayed import ${batch.id} (${batch.fileName}): ${rows.length} rows`,
    );
  }

  const stored = await pool.query<{ total: string }>(
    `select count(*)::int as total from kdp_sale_transactions
     where workspace_id = $1`,
    [workspaceId],
  );
  console.log(
    `wiped ${wiped.rowCount ?? 0} transactions, replayed ${replayed} rows ` +
      `from ${replayable.length} imports — ${stored.rows[0]?.total ?? "?"} stored now`,
  );
  for (const batch of missing) {
    console.log(
      `note: import ${batch.id} (${batch.fileName}) predates row storage; ` +
        `re-upload the file to make it rebuildable`,
    );
  }
} finally {
  await pool.end();
}
