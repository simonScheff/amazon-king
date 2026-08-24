-- Persistent workspace-level search-term exclusions. Excluding a term drafts
-- approval-gated negative change sets across all markets once; this list is
-- what the worker's enforcement pass reads to keep future campaigns covered,
-- and what the recommendation run feeds into the optimizer's
-- protectedSearchTerms so an excluded term stops raising wasteful_search_term
-- findings.
--
-- search_term is stored normalized (trimmed + lowercased) at write time, the
-- same convention as recommendation_dismissals, so casing drift between
-- report imports cannot duplicate or resurrect an exclusion.
create table search_term_exclusions (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  search_term text not null,
  created_at timestamptz not null default now(),
  -- The unique index doubles as the foreign-key index on workspace_id.
  unique (workspace_id, search_term)
);
