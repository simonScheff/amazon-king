-- ASIN product targeting: product targets in the campaign-creation chain and
-- campaign-level negative ASIN targets for cannibalization resolution.
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
    'add_negative_target'
  ));
