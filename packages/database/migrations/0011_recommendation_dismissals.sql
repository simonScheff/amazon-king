-- Persistent dismissal of recommendations (plan §9). Rejecting a finding used
-- to change only its own state, so the next recommendation_run re-inserted an
-- identical pending row from the same still-valid evidence. A dismissal
-- records the finding's identity so future runs stay quiet about it until
-- dismissed_until passes (null = forever).
--
-- The identity mirrors the pending-dedupe tuple in the worker. Nullable parts
-- must compare as equal, hence `unique nulls not distinct` (PostgreSQL 15+).
-- search_term is stored trimmed and lowercased so casing drift between report
-- imports cannot resurrect a dismissed finding.
create table recommendation_dismissals (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  type text not null,
  campaign_id bigint references campaigns (id),
  ad_group_id bigint references ad_groups (id),
  target_id bigint references targets (id),
  search_term text,
  recommendation_id bigint references recommendations (id),
  dismissed_at timestamptz not null default now(),
  dismissed_until timestamptz,
  unique nulls not distinct
    (profile_id, type, campaign_id, ad_group_id, target_id, search_term)
);

create index idx_recommendation_dismissals_active
  on recommendation_dismissals (profile_id, type, dismissed_until);
