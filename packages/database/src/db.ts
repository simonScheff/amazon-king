import type { Pool, PoolClient } from "pg";

/**
 * Minimal queryable surface shared by Pool and PoolClient so repository
 * functions can run standalone or inside a caller-managed transaction.
 */
export interface Db {
  query: Pool["query"];
}

export type { Pool, PoolClient };
