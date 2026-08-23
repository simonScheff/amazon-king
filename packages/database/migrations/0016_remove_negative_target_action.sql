-- Re-include after exclusion: removing a synced negative product (ASIN) target
-- gets its own action type so a removal can be drafted, guarded, and verified
-- like remove_negative_exact.
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
    'remove_negative_target',
    'update_campaign_state',
    'update_campaign_name'
  ));
