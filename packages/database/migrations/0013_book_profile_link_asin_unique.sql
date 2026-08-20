-- One catalog book owns a given advertised ASIN inside a profile. Owner-
-- confirmed marketplace links (no prior ads) and ads-derived mappings share
-- this table; the unique key stops two books from claiming the same ASIN.
create unique index idx_book_profile_links_profile_asin
  on book_profile_links (profile_id, marketplace_asin);
