-- Campaign pause/enable and rename from the dashboard: one-click guarded
-- change sets (kind 'campaign_update') holding a single
-- update_campaign_state or update_campaign_name action.
alter table change_sets
  drop constraint change_sets_kind_check;

alter table change_sets
  add constraint change_sets_kind_check check (kind in (
    'recommendation',
    'max_cpc',
    'rollback',
    'campaign_creation',
    'campaign_update'
  ));

alter table change_actions
  drop constraint change_actions_action_type_check;

alter table change_actions
  add constraint change_actions_action_type_check check (action_type in (
    'update_bid',
    'update_ad_group_default_bid',
    'update_campaign_bidding',
    'update_optimization_rule',
    'add_negative_exact',
    'remove_negative_exact',
    'create_campaign',
    'create_ad_group',
    'create_product_ad',
    'create_keyword',
    'create_target',
    'add_negative_target',
    'update_campaign_state',
    'update_campaign_name'
  ));
