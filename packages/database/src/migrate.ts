import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withTransaction } from "./pool.js";
import type { Db, Pool } from "./db.js";

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export interface MigrationFile {
  /** Numeric prefix, e.g. "0001". */
  version: string;
  filename: string;
  sql: string;
}

const MIGRATION_NAME = /^(\d{4})_.+\.sql$/;

/**
 * Read and validate the migrations directory. Files must be named
 * NNNN_description.sql with strictly increasing, gap-free numbering.
 * Pure filesystem access — no database needed.
 */
export async function loadMigrations(
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      throw new Error(
        `Invalid migration filename: ${name} (expected NNNN_description.sql)`,
      );
    }
    const version = match[1]!;
    const expected = String(files.length + 1).padStart(4, "0");
    if (version !== expected) {
      throw new Error(
        `Migration numbering gap: expected ${expected}, found ${name}`,
      );
    }
    const sql = await readFile(`${dir}/${name}`, "utf8");
    if (sql.trim().length === 0) {
      throw new Error(`Migration file is empty: ${name}`);
    }
    files.push({ version, filename: name, sql });
  }
  return files;
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      version text primary key,
      filename text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function appliedVersions(db: Db): Promise<Set<string>> {
  const result = await db.query<{ version: string }>(
    "select version from schema_migrations",
  );
  return new Set(result.rows.map((row) => row.version));
}

/**
 * Apply all pending migrations in order, each inside its own transaction,
 * recording rows in schema_migrations. Returns the versions applied now.
 */
export async function migrate(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = await loadMigrations(dir);
  await ensureMigrationsTable(pool);
  const applied = await appliedVersions(pool);
  const appliedNow: string[] = [];
  for (const file of files) {
    if (applied.has(file.version)) {
      continue;
    }
    await withTransaction(pool, async (client) => {
      await client.query(file.sql);
      await client.query(
        "insert into schema_migrations (version, filename) values ($1, $2)",
        [file.version, file.filename],
      );
    });
    appliedNow.push(file.version);
  }
  return appliedNow;
}
