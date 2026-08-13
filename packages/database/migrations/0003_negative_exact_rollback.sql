-- Compensating deletion for a verified negative-exact addition.
alter table change_actions
  drop constraint change_actions_action_type_check;

alter table change_actions
  add constraint change_actions_action_type_check check (action_type in (
    'update_bid',
    'update_ad_group_default_bid',
    'update_campaign_bidding',
    'update_optimization_rule',
    'add_negative_exact',
    'remove_negative_exact'
  ));
