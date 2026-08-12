-- Initial schema for amazon-king (docs/plan.md §7).
-- Conventions:
--   internal PKs: bigint generated always as identity
--   Amazon IDs: text, unique per profile
--   money: numeric(19,4), never aggregated across currencies
--   timestamps: timestamptz default now()
--   counts: non-negative CHECK constraints
--   attribution windows stay explicit (purchases7d/sales7d vs purchases14d/sales14d)

-- ---------------------------------------------------------------------------
-- Identity and connections
-- ---------------------------------------------------------------------------

create table users (
  id bigint generated always as identity primary key,
  auth_provider_id text,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table workspaces (
  id bigint generated always as identity primary key,
  name text not null,
  timezone text,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id bigint not null references workspaces (id),
  user_id bigint not null references users (id),
  role text not null check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index idx_workspace_members_user on workspace_members (user_id);

create table amazon_connections (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  -- KMS/envelope-encrypted refresh token; never stored in plaintext.
  encrypted_refresh_token bytea not null,
  encryption_key_version integer not null,
  status text not null check (status in ('connected', 'reconnect_required', 'disconnected')),
  granted_at timestamptz,
  revoked_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now()
);
create index idx_amazon_connections_workspace on amazon_connections (workspace_id);

create table amazon_profiles (
  id bigint generated always as identity primary key,
  connection_id bigint not null references amazon_connections (id),
  profile_id text not null unique, -- Amazon's profile id
  account_id text,
  region text not null check (region in ('NA', 'EU', 'FE')),
  country_code text not null,
  currency_code char(3) not null,
  timezone text,
  account_type text,
  enabled boolean not null default false,
  write_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_amazon_profiles_connection on amazon_profiles (connection_id);

-- ---------------------------------------------------------------------------
-- Sessions and auth
-- ---------------------------------------------------------------------------

create table sessions (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index idx_sessions_user on sessions (user_id);

-- Passwordless email sign-in tokens (Login A).
create table login_tokens (
  id bigint generated always as identity primary key,
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- One-time expiring OAuth state (Login B), tied to the authenticated user.
create table oauth_states (
  id bigint generated always as identity primary key,
  state_hash text not null unique,
  user_id bigint not null references users (id),
  return_to text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_oauth_states_user on oauth_states (user_id);

-- ---------------------------------------------------------------------------
-- KDP catalog and economics
-- ---------------------------------------------------------------------------

create table books (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  asin text not null,
  title text not null,
  format text not null,
  status text not null default 'active',
  cover_json jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, asin, format)
);
create index idx_books_workspace on books (workspace_id);

create table book_profile_links (
  book_id bigint not null references books (id),
  profile_id bigint not null references amazon_profiles (id),
  marketplace_asin text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (book_id, profile_id)
);
create index idx_book_profile_links_profile on book_profile_links (profile_id);

-- User-entered KDP royalty economics, effective-dated. Never guessed.
create table book_economics (
  id bigint generated always as identity primary key,
  book_id bigint not null references books (id),
  profile_id bigint not null references amazon_profiles (id),
  effective_from date not null,
  currency char(3) not null,
  list_price numeric(19,4) not null check (list_price >= 0),
  estimated_royalty_per_sale numeric(19,4) not null check (estimated_royalty_per_sale >= 0),
  target_acos numeric(9,4) check (target_acos >= 0 and target_acos <= 1),
  goal_mode text not null check (goal_mode in ('profit', 'balanced', 'launch', 'visibility')),
  max_spend_without_sale numeric(19,4) check (max_spend_without_sale >= 0),
  max_bid numeric(19,4) check (max_bid >= 0),
  max_daily_budget numeric(19,4) check (max_daily_budget >= 0),
  notes text,
  created_at timestamptz not null default now(),
  unique (book_id, profile_id, effective_from)
);
create index idx_book_economics_book on book_economics (book_id);
create index idx_book_economics_profile on book_economics (profile_id);

-- ---------------------------------------------------------------------------
-- Campaign structure (current snapshot + change history)
-- ---------------------------------------------------------------------------

create table campaigns (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  amazon_campaign_id text not null,
  name text not null,
  state text not null,
  targeting_type text,
  daily_budget numeric(19,4) check (daily_budget >= 0),
  portfolio_id text,
  start_date date,
  end_date date,
  raw_json jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (profile_id, amazon_campaign_id)
);
create index idx_campaigns_profile on campaigns (profile_id);

create table ad_groups (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id bigint not null references campaigns (id),
  amazon_ad_group_id text not null,
  name text not null,
  state text not null,
  default_bid numeric(19,4) check (default_bid >= 0),
  raw_json jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (profile_id, amazon_ad_group_id)
);
create index idx_ad_groups_profile on ad_groups (profile_id);
create index idx_ad_groups_campaign on ad_groups (campaign_id);

create table ads (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  ad_group_id bigint not null references ad_groups (id),
  amazon_ad_id text not null,
  asin text not null,
  state text not null,
  raw_json jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (profile_id, amazon_ad_id)
);
create index idx_ads_profile on ads (profile_id);
create index idx_ads_ad_group on ads (ad_group_id);

create table targets (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id bigint not null references campaigns (id),
  ad_group_id bigint not null references ad_groups (id),
  amazon_target_id text not null,
  target_kind text not null,
  expression jsonb,
  match_type text,
  bid numeric(19,4) check (bid >= 0),
  state text not null,
  raw_json jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (profile_id, amazon_target_id)
);
create index idx_targets_profile on targets (profile_id);
create index idx_targets_campaign on targets (campaign_id);
create index idx_targets_ad_group on targets (ad_group_id);

-- Lightweight audit of name/bid/budget/state changes on structure entities.
-- entity_id is the internal identity PK of the affected row.
create table entity_change_history (
  id bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('campaign', 'ad_group', 'ad', 'target')),
  entity_id bigint not null,
  field text not null,
  old_value text,
  new_value text,
  changed_at timestamptz not null default now()
);
create index idx_entity_change_history_entity on entity_change_history (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Daily performance facts (one table per report grain)
-- ---------------------------------------------------------------------------

create table campaign_metrics_daily (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id text not null, -- Amazon campaign id
  metric_date date not null,
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  cost numeric(19,4) not null default 0 check (cost >= 0),
  sales numeric(19,4) not null default 0 check (sales >= 0),
  orders integer not null default 0 check (orders >= 0),
  purchases7d integer not null default 0 check (purchases7d >= 0),
  sales7d numeric(19,4) not null default 0 check (sales7d >= 0),
  purchases14d integer not null default 0 check (purchases14d >= 0),
  sales14d numeric(19,4) not null default 0 check (sales14d >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  unique (profile_id, campaign_id, metric_date)
);
create index idx_campaign_metrics_dashboard
  on campaign_metrics_daily (profile_id, metric_date desc, campaign_id);

create table target_metrics_daily (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id text not null,
  ad_group_id text not null,
  target_id text not null,
  metric_date date not null,
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  cost numeric(19,4) not null default 0 check (cost >= 0),
  sales numeric(19,4) not null default 0 check (sales >= 0),
  orders integer not null default 0 check (orders >= 0),
  purchases7d integer not null default 0 check (purchases7d >= 0),
  sales7d numeric(19,4) not null default 0 check (sales7d >= 0),
  purchases14d integer not null default 0 check (purchases14d >= 0),
  sales14d numeric(19,4) not null default 0 check (sales14d >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  unique (profile_id, target_id, metric_date)
);
create index idx_target_metrics_dashboard
  on target_metrics_daily (profile_id, metric_date desc, target_id);

create table search_term_metrics_daily (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id text not null,
  ad_group_id text not null,
  target_id text not null,
  search_term text not null,
  metric_date date not null,
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  cost numeric(19,4) not null default 0 check (cost >= 0),
  sales numeric(19,4) not null default 0 check (sales >= 0),
  orders integer not null default 0 check (orders >= 0),
  purchases7d integer not null default 0 check (purchases7d >= 0),
  sales7d numeric(19,4) not null default 0 check (sales7d >= 0),
  purchases14d integer not null default 0 check (purchases14d >= 0),
  sales14d numeric(19,4) not null default 0 check (sales14d >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  unique (profile_id, target_id, search_term, metric_date)
);
create index idx_search_term_metrics_dashboard
  on search_term_metrics_daily (profile_id, metric_date desc, campaign_id);

create table advertised_product_metrics_daily (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id text not null,
  ad_group_id text not null,
  ad_id text not null,
  metric_date date not null,
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  cost numeric(19,4) not null default 0 check (cost >= 0),
  sales numeric(19,4) not null default 0 check (sales >= 0),
  orders integer not null default 0 check (orders >= 0),
  purchases7d integer not null default 0 check (purchases7d >= 0),
  sales7d numeric(19,4) not null default 0 check (sales7d >= 0),
  purchases14d integer not null default 0 check (purchases14d >= 0),
  sales14d numeric(19,4) not null default 0 check (sales14d >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  unique (profile_id, ad_id, metric_date)
);
create index idx_advertised_product_metrics_dashboard
  on advertised_product_metrics_daily (profile_id, metric_date desc, ad_id);

create table placement_metrics_daily (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  campaign_id text not null,
  placement text not null,
  metric_date date not null,
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  cost numeric(19,4) not null default 0 check (cost >= 0),
  sales numeric(19,4) not null default 0 check (sales >= 0),
  orders integer not null default 0 check (orders >= 0),
  purchases7d integer not null default 0 check (purchases7d >= 0),
  sales7d numeric(19,4) not null default 0 check (sales7d >= 0),
  purchases14d integer not null default 0 check (purchases14d >= 0),
  sales14d numeric(19,4) not null default 0 check (sales14d >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  unique (profile_id, campaign_id, placement, metric_date)
);
create index idx_placement_metrics_dashboard
  on placement_metrics_daily (profile_id, metric_date desc, campaign_id);

-- ---------------------------------------------------------------------------
-- Pipeline, recommendations, and writes
-- ---------------------------------------------------------------------------

create table sync_runs (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  kind text not null check (kind in ('structure', 'metrics', 'backfill')),
  status text not null default 'running' check (status in ('running', 'complete', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);
create index idx_sync_runs_profile on sync_runs (profile_id);

create table report_jobs (
  id bigint generated always as identity primary key,
  sync_run_id bigint not null references sync_runs (id),
  profile_id bigint not null references amazon_profiles (id),
  report_type text not null,
  -- Deterministic fingerprint of profile/type/date range/columns; dedupes requests.
  spec_fingerprint text not null unique,
  amazon_report_id text,
  status text not null default 'queued' check (status in (
    'queued', 'requested', 'polling', 'downloading', 'validating',
    'importing', 'complete', 'retryable', 'failed', 'dead_letter'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  checksum text,
  storage_key text,
  error text,
  date_start date not null,
  date_end date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_report_jobs_sync_run on report_jobs (sync_run_id);
create index idx_report_jobs_profile on report_jobs (profile_id);
create index idx_report_jobs_status on report_jobs (status) where status <> 'complete';

-- Durable internal work queue. Claimed with FOR UPDATE SKIP LOCKED + leases.
create table job_queue (
  id bigint generated always as identity primary key,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now()
);
create index idx_job_queue_claim on job_queue (status, run_at);
create index idx_job_queue_pending on job_queue (run_at) where status = 'pending';

create table recommendations (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  type text not null check (type in (
    'wasteful_search_term', 'expensive_target', 'profitable_target',
    'search_term_harvest', 'budget_constrained_winner', 'high_ctr_poor_conversion',
    'low_impressions', 'placement_opportunity', 'cannibalization_conflict'
  )),
  campaign_id bigint references campaigns (id),
  ad_group_id bigint references ad_groups (id),
  target_id bigint references targets (id),
  search_term text,
  priority integer not null check (priority between 1 and 5),
  evidence_window_start date not null,
  evidence_window_end date not null,
  current_value numeric(19,4),
  proposed_value numeric(19,4),
  rationale text not null,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  state text not null default 'pending' check (state in (
    'pending', 'approved', 'rejected', 'expired', 'applied', 'protected'
  )),
  rule_version text not null,
  data_freshness_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index idx_recommendations_profile on recommendations (profile_id);
create index idx_recommendations_campaign on recommendations (campaign_id);
create index idx_recommendations_ad_group on recommendations (ad_group_id);
create index idx_recommendations_target on recommendations (target_id);
create index idx_recommendations_pending
  on recommendations (profile_id, priority) where state = 'pending';

-- Immutable rule inputs so a recommendation is reproducible.
create table recommendation_evidence (
  id bigint generated always as identity primary key,
  recommendation_id bigint not null references recommendations (id),
  inputs jsonb not null,
  created_at timestamptz not null default now()
);
create index idx_recommendation_evidence_recommendation
  on recommendation_evidence (recommendation_id);

create table change_sets (
  id bigint generated always as identity primary key,
  profile_id bigint not null references amazon_profiles (id),
  creator_user_id bigint not null references users (id),
  status text not null default 'draft' check (status in (
    'draft', 'previewed', 'applying', 'applied', 'partially_applied', 'failed', 'blocked'
  )),
  guardrail_result jsonb,
  fingerprint text not null unique,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create index idx_change_sets_profile on change_sets (profile_id);
create index idx_change_sets_creator on change_sets (creator_user_id);

create table change_actions (
  id bigint generated always as identity primary key,
  change_set_id bigint not null references change_sets (id),
  recommendation_id bigint references recommendations (id),
  action_type text not null check (action_type in ('update_bid', 'add_negative_exact')),
  campaign_id bigint references campaigns (id),
  ad_group_id bigint references ad_groups (id),
  target_id bigint references targets (id),
  search_term text,
  before_value numeric(19,4),
  after_value numeric(19,4),
  fingerprint text not null unique,
  status text not null default 'pending' check (status in (
    'pending', 'applied', 'partially_applied', 'failed', 'verification_failed', 'rolled_back'
  )),
  amazon_request jsonb,
  amazon_response jsonb,
  amazon_request_id text,
  verified_at timestamptz,
  rollback_of_id bigint references change_actions (id),
  created_at timestamptz not null default now()
);
create index idx_change_actions_change_set on change_actions (change_set_id);
create index idx_change_actions_recommendation on change_actions (recommendation_id);
create index idx_change_actions_rollback_of on change_actions (rollback_of_id);

create table audit_events (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  actor_user_id bigint references users (id),
  event text not null,
  entity_type text not null,
  entity_id text,
  ip text,
  session_id bigint references sessions (id),
  -- Safe, non-secret details only (no tokens, secrets, or pre-signed URLs).
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_events_workspace on audit_events (workspace_id, created_at desc);
create index idx_audit_events_actor on audit_events (actor_user_id);
