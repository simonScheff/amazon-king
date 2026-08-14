-- Remember which web origin a login was started from (localhost, tunnel,
-- etc.) so the magic link and post-verify redirect return to that same
-- origin instead of a single static WEB_ORIGIN.
alter table login_tokens add column origin text;
