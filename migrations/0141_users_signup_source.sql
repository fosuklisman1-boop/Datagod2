-- 0141_users_signup_source.sql
-- Sign-up attribution: the first main-site page a new user landed on
-- ({ landing, ref, utm_source?, utm_medium?, utm_campaign?, at }), written once
-- at sign-up by /api/auth/signup. Nullable, no backfill, no index.
alter table public.users add column if not exists signup_source jsonb;
