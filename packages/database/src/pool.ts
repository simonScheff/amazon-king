import pg from "pg";
import type { Db, Pool, PoolClient } from "./db.js";

/** Create a connection pool for the given Postgres URL. */
export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

/**
 * Run fn inside a transaction on a dedicated client. Commits on success,
 * rolls back on any thrown error, and always releases the client.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export type { Db };
