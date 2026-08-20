-- Persist campaign- and ad-group-level negative product targets (ASIN_SAME_AS
-- exclusions) returned by structure sync. cannibalization_conflict@2 already
-- excludes campaigns blocked by negative keywords; ASIN shopper terms are
-- blocked with these targets instead, and until they are mirrored locally the
-- rule keeps re-raising a conflict the owner already resolved.

create table negative_targets (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id bigint not null references campaigns (id),
  ad_group_id bigint references ad_groups (id),
  amazon_negative_target_id text not null,
  expression_asin text not null,
  state text not null,
  raw_json jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (profile_id, amazon_negative_target_id)
);

create index idx_negative_targets_profile on negative_targets (profile_id);
create index idx_negative_targets_campaign on negative_targets (campaign_id);
create index idx_negative_targets_ad_group on negative_targets (ad_group_id);
