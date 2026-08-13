-- One campaign-level CPC ceiling, enforced through guarded multi-entity writes.
alter table change_sets
  add column kind text not null default 'recommendation'
    check (kind in ('recommendation', 'max_cpc', 'rollback')),
  add column metadata jsonb not null default '{}'::jsonb;

alter table change_actions
  drop constraint change_actions_action_type_check;

alter table change_actions
  add constraint change_actions_action_type_check check (action_type in (
    'update_bid',
    'update_ad_group_default_bid',
    'update_campaign_bidding',
    'update_optimization_rule',
    'add_negative_exact'
  )),
  add column amazon_entity_id text,
  add column entity_name text,
  add column before_state jsonb,
  add column after_state jsonb;

create table campaign_bid_policies (
  id bigint generated always as identity primary key,
  campaign_id bigint not null unique references campaigns (id),
  max_cpc numeric(19,4) not null check (max_cpc > 0),
  status text not null check (status in ('pending', 'active', 'drifted')),
  change_set_id bigint references change_sets (id),
  enforced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_campaign_bid_policies_change_set
  on campaign_bid_policies (change_set_id);
