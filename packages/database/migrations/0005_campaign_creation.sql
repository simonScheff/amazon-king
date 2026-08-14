-- Campaign creation change sets: draft campaigns/ad groups/product ads/keywords
-- created through the guarded write path (kind 'campaign_creation').
alter table change_sets
  drop constraint change_sets_kind_check;

alter table change_sets
  add constraint change_sets_kind_check check (kind in (
    'recommendation',
    'max_cpc',
    'rollback',
    'campaign_creation'
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
    'create_keyword'
  ));
