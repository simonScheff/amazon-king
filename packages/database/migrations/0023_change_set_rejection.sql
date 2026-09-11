-- Allow change sets to be rejected/dismissed without applying to Amazon.
alter table change_sets
  drop constraint change_sets_status_check;

alter table change_sets
  add constraint change_sets_status_check check (status in (
    'draft',
    'previewed',
    'applying',
    'applied',
    'partially_applied',
    'failed',
    'blocked',
    'rejected'
  ));
