-- Persist the negative-keyword structure already returned by the Amazon Ads
-- gateway so campaign explorer screens can show the current Amazon state.

create table negative_keywords (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id bigint not null references campaigns (id),
  ad_group_id bigint references ad_groups (id),
  amazon_negative_keyword_id text not null,
  keyword_text text not null,
  match_type text not null,
  state text not null,
  raw_json jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (profile_id, amazon_negative_keyword_id)
);

create index idx_negative_keywords_profile on negative_keywords (profile_id);
create index idx_negative_keywords_campaign on negative_keywords (campaign_id);
create index idx_negative_keywords_ad_group on negative_keywords (ad_group_id);
