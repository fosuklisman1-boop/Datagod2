-- 0079_block_disposable_email_signups.sql
--
-- Anti-abuse: reject signups from disposable/temporary email providers.
--
-- Enforced as a BEFORE INSERT trigger on auth.users so it covers EVERY signup
-- path — including an attacker calling supabase.auth.signUp directly with the
-- public anon key (which bypasses the Next.js app, so an app-route check can't
-- stop it). Added 2026-06-21 during an active pentest that was flooding signups
-- with mailinator/tempmail/yopmail accounts.
--
-- Raising an exception makes GoTrue return an error and abort the signup (no
-- auth.users row, so the 0058 handle_new_user AFTER trigger never fires).
-- Applied live via the Management API.

CREATE OR REPLACE FUNCTION public.reject_disposable_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  dom text := lower(split_part(coalesce(NEW.email, ''), '@', 2));
BEGIN
  IF dom <> '' AND dom ~ '(mailinator|tempmail|temp-mail|yopmail|guerrilla|sharklasers|trashmail|10minutemail|getnada|dispostable|maildrop|moakt|fakeinbox|throwaway|emailondeck|mintemail|discard|spam4|trbvm|tempr)' THEN
    RAISE EXCEPTION 'disposable_email_blocked: temporary/disposable email providers are not allowed';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS reject_disposable_email_trg ON auth.users;
CREATE TRIGGER reject_disposable_email_trg
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.reject_disposable_email();
