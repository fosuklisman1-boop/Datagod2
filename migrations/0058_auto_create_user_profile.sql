-- 0058_auto_create_user_profile.sql
--
-- Guarantee that every auth.users row has a matching public.users row, created in
-- the SAME transaction as the auth signup — so an orphaned auth user (auth account
-- with no profile) becomes impossible by construction. This is the root fix for
-- the 16 orphans the lockdown produced (the app-level INSERT in /api/auth/signup
-- failed with 42501 and left auth users with no profile).
--
-- After this, "onboarded" is defined as phone_number IS NOT NULL — NOT "a row
-- exists" (every auth user now has a row immediately, with phone_number NULL until
-- they complete profile).
--
-- Safe to run multiple times.

-- 1. The trigger function. CARDINAL RULE: it must never throw, or it would block
--    the auth signup it fires inside. SECURITY DEFINER so it can write public.users
--    regardless of the caller's role; ON CONFLICT + EXCEPTION guard make it
--    idempotent and failure-proof. It sets only what's needed (id, email) plus a
--    best-effort name from the OAuth metadata; everything else uses column defaults
--    (role='user', status='active', onboarding_completed=false, phone_verified=false,
--    phone_number=NULL).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  full_name text := COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', '');
  fname text;
  lname text;
BEGIN
  fname := NULLIF(split_part(full_name, ' ', 1), '');
  lname := NULLIF(btrim(substr(full_name, length(split_part(full_name, ' ', 1)) + 2)), '');

  INSERT INTO public.users (id, email, first_name, last_name, role)
  VALUES (NEW.id, COALESCE(NEW.email, ''), fname, lname, 'user')
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block an auth signup because profile creation failed.
  RAISE WARNING 'handle_new_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- 2. Fire it after every auth signup.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Backfill the existing orphans (auth users with no profile row). phone_number
--    stays NULL, so they'll be routed through complete-profile on next login.
INSERT INTO public.users (id, email, first_name, last_name, role)
SELECT
  au.id,
  COALESCE(au.email, ''),
  NULLIF(split_part(COALESCE(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', ''), ' ', 1), ''),
  NULLIF(btrim(substr(
    COALESCE(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', ''),
    length(split_part(COALESCE(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', ''), ' ', 1)) + 2
  )), ''),
  'user'
FROM auth.users au
LEFT JOIN public.users pu ON pu.id = au.id
WHERE pu.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- VERIFY:
--   -- orphan count should now be 0
--   SELECT COUNT(*) AS orphaned_auth_users
--     FROM auth.users au LEFT JOIN public.users pu ON pu.id = au.id
--    WHERE pu.id IS NULL;
--
--   -- trigger should be listed
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal;
-- ───────────────────────────────────────────────────────────────────────────
