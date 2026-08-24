import type { Db } from "../db.js";

/**
 * Workspace-level persistent search-term exclusions (migration 0018). Terms
 * are normalized (trimmed + lowercased) at write time, mirroring
 * recommendation_dismissals, so every writer converges on one row per term.
 */

export interface SearchTermExclusion {
  id: string;
  workspaceId: string;
  searchTerm: string;
  createdAt: string;
}

interface SearchTermExclusionRow {
  id: string;
  workspace_id: string;
  search_term: string;
  created_at: string;
}

function toExclusion(row: SearchTermExclusionRow): SearchTermExclusion {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    searchTerm: row.search_term,
    createdAt: row.created_at,
  };
}

/** Trim + lowercase; the stored form of every excluded term. */
export function normalizeExclusionTerm(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Add a term to the workspace exclusion list. Idempotent: re-adding an
 * already-excluded term returns the existing row with `created: false`.
 */
export async function addExclusion(
  db: Db,
  workspaceId: string,
  searchTerm: string,
): Promise<{ exclusion: SearchTermExclusion; created: boolean }> {
  const normalized = normalizeExclusionTerm(searchTerm);
  const inserted = await db.query<SearchTermExclusionRow>(
    `insert into search_term_exclusions (workspace_id, search_term)
     values ($1, $2)
     on conflict (workspace_id, search_term) do nothing
     returning *`,
    [workspaceId, normalized],
  );
  if (inserted.rows[0]) {
    return { exclusion: toExclusion(inserted.rows[0]), created: true };
  }
  const existing = await db.query<SearchTermExclusionRow>(
    `select * from search_term_exclusions
     where workspace_id = $1 and search_term = $2`,
    [workspaceId, normalized],
  );
  return { exclusion: toExclusion(existing.rows[0]!), created: false };
}

/**
 * Remove a term from the exclusion list. Only the list entry goes — negatives
 * already applied on Amazon stay (re-including them is the existing
 * negative-removal flow). False when the term was not excluded.
 */
export async function removeExclusion(
  db: Db,
  workspaceId: string,
  searchTerm: string,
): Promise<boolean> {
  const result = await db.query(
    `delete from search_term_exclusions
     where workspace_id = $1 and search_term = $2`,
    [workspaceId, normalizeExclusionTerm(searchTerm)],
  );
  return result.rowCount === 1;
}

/** Every excluded term of a workspace, alphabetically. */
export async function listExclusions(
  db: Db,
  workspaceId: string,
): Promise<SearchTermExclusion[]> {
  const result = await db.query<SearchTermExclusionRow>(
    `select * from search_term_exclusions
     where workspace_id = $1
     order by search_term`,
    [workspaceId],
  );
  return result.rows.map(toExclusion);
}
