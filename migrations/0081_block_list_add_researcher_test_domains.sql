-- 0081_block_list_add_researcher_test_domains.sql
--
-- Extends the 0079 disposable-email block: after disposable domains were blocked,
-- the same tester switched to wearehackerone.com (HackerOne's researcher alias
-- domain) and test@test.com. Add those, using an EXACT-domain list for generic
-- domains like test.com/example.* (NOT a substring match — "test" as a substring
-- would wrongly block legitimate domains like "greatest.com"/"testco.com").
-- Applied live via the Management API 2026-06-22.

CREATE OR REPLACE FUNCTION public.reject_disposable_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  dom text := lower(split_part(coalesce(NEW.email, ''), '@', 2));
BEGIN
  IF dom <> '' AND (
       dom ~ '(mailinator|tempmail|temp-mail|yopmail|guerrilla|sharklasers|trashmail|10minutemail|getnada|dispostable|maildrop|moakt|fakeinbox|throwaway|emailondeck|mintemail|discard|spam4|trbvm|tempr|wearehackerone)'
       OR dom IN ('test.com', 'example.com', 'example.org', 'example.net')
     ) THEN
    RAISE EXCEPTION 'disposable_email_blocked: temporary/disposable or test email providers are not allowed';
  END IF;
  RETURN NEW;
END;
$fn$;
-- Trigger reject_disposable_email_trg (created in 0079) already points at this
-- function; CREATE OR REPLACE updates it in place.
