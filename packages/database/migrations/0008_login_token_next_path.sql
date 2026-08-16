--- Remember which in-app path a login was started from (e.g. the re-auth
--- dialog on /changes) so the post-verify redirect returns the user to the
--- page they were on. Only same-origin relative paths are ever stored; the
--- API validates the shape at the boundary and again on verify.
alter table login_tokens add column next_path text;
