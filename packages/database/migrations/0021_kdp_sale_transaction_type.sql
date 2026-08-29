-- The verbatim KDP transaction rows (0020) dropped the report's Transaction
-- Type. The fulfillment-lag metric (royalty_date - order_date) must exclude
-- Expanded Distribution rows — a third party prints those, so their lag is
-- not Amazon's print-and-ship time — and that classification needs both the
-- royalty type and the transaction type, the same pair the import flow uses
-- to split standard-rate from expanded rows. Rows stored before this column
-- keep the empty default; they are re-imported (replaced) on the next upload.
alter table kdp_sale_transactions
  add column transaction_type text not null default '';
