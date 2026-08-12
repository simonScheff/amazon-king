/**
 * Migration CLI. Applies all pending SQL migrations from
 * packages/database/migrations against DATABASE_URL.
 *
 * Usage: pnpm exec tsx scripts/migrate.ts   (or `make migrate`)
 */
import { createPool, migrate } from "@amazon-king/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set (copy .env.example to .env first)");
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  const applied = await migrate(pool);
  if (applied.length === 0) {
    console.log("Database is up to date — no pending migrations.");
  } else {
    console.log(`Applied migrations: ${applied.join(", ")}`);
  }
} finally {
  await pool.end();
}
