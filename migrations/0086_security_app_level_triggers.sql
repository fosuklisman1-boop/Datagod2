-- 0086_security_app_level_triggers.sql
--
-- App-level attack detection. The DB triggers in 0085 catch suspicious DATA
-- CHANGES (forged orders, mints, escalation) regardless of path. These three
-- watch the tables the APP fills as it defends itself, so they catch app-layer
-- abuse that leaves no money/role footprint: credential stuffing / endpoint
-- hammering (rate_limit_blocks), password-reset abuse, and OTP-request bursts
-- (the vector that hit the owner's admin account on 2026-06-21).
--
-- All FAIL-OPEN (EXCEPTION WHEN OTHERS THEN RETURN NEW) and de-duped (one alert
-- per subject per window) to avoid blocking writes or spamming admins.
-- Applied live via the Management API 2026-06-22.

-- 1) Rate-limit abuse: an identifier tripping limits repeatedly = automated
--    abuse. Auth-sensitive endpoints escalate to critical at a lower threshold.
CREATE OR REPLACE FUNCTION public.sec_detect_rate_abuse()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE cnt int; recent int; sensitive boolean; sev text; thresh int;
BEGIN
  sensitive := NEW.endpoint ~* '(login|signin|signup|sign_up|otp|reset|password|verify|admin|auth)';
  thresh := CASE WHEN sensitive THEN 5 ELSE 10 END;
  SELECT count(*) INTO cnt FROM public.rate_limit_blocks
    WHERE identifier = NEW.identifier AND blocked_at > now() - interval '10 minutes';
  IF cnt >= thresh THEN
    SELECT count(*) INTO recent FROM public.security_alerts
      WHERE category = 'rate_abuse' AND detail->>'identifier' = NEW.identifier
        AND created_at > now() - interval '15 minutes';
    IF recent = 0 THEN
      sev := CASE WHEN sensitive THEN 'critical' ELSE 'high' END;
      PERFORM public.raise_security_alert(sev, 'rate_abuse',
        'Rate-limit abuse: ' || NEW.identifier || ' tripped ' || cnt || ' limits in 10min (latest: ' || NEW.endpoint || ')',
        jsonb_build_object('identifier', NEW.identifier, 'count_10min', cnt, 'latest_endpoint', NEW.endpoint, 'sensitive', sensitive),
        NEW.identifier);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_rate_abuse_trg ON public.rate_limit_blocks;
CREATE TRIGGER sec_detect_rate_abuse_trg AFTER INSERT ON public.rate_limit_blocks
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_rate_abuse();

-- 2) Password-reset abuse: many resets for one account (the owner saw reset
--    links they did not request), or a spray across many accounts from one IP.
CREATE OR REPLACE FUNCTION public.sec_detect_reset_abuse()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE per_target int; per_ip int; recent int; tgt text;
BEGIN
  tgt := COALESCE(NEW.email, NEW.phone_number, NEW.user_id::text, 'unknown');
  SELECT count(*) INTO per_target FROM public.password_reset_requests
    WHERE COALESCE(email, phone_number, user_id::text) = tgt
      AND created_at > now() - interval '60 minutes';
  IF per_target >= 3 THEN
    SELECT count(*) INTO recent FROM public.security_alerts
      WHERE category = 'reset_abuse' AND detail->>'target' = tgt AND created_at > now() - interval '60 minutes';
    IF recent = 0 THEN
      PERFORM public.raise_security_alert('high', 'reset_abuse',
        'Multiple password resets for ' || tgt || ' (' || per_target || ' in 1h)',
        jsonb_build_object('target', tgt, 'count_1h', per_target, 'ip', NEW.ip_address), tgt, NEW.ip_address);
    END IF;
  END IF;
  IF NEW.ip_address IS NOT NULL AND NEW.ip_address <> '' THEN
    SELECT count(*) INTO per_ip FROM public.password_reset_requests
      WHERE ip_address = NEW.ip_address AND created_at > now() - interval '60 minutes';
    IF per_ip >= 6 THEN
      SELECT count(*) INTO recent FROM public.security_alerts
        WHERE category = 'reset_abuse' AND detail->>'spray_ip' = NEW.ip_address AND created_at > now() - interval '60 minutes';
      IF recent = 0 THEN
        PERFORM public.raise_security_alert('high', 'reset_abuse',
          'Password-reset spray from IP ' || NEW.ip_address || ' (' || per_ip || ' requests in 1h)',
          jsonb_build_object('spray_ip', NEW.ip_address, 'count_1h', per_ip), NEW.ip_address, NEW.ip_address);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_reset_abuse_trg ON public.password_reset_requests;
CREATE TRIGGER sec_detect_reset_abuse_trg AFTER INSERT ON public.password_reset_requests
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_reset_abuse();

-- 3) OTP-request burst for a single phone (OTP-bombing / harvesting).
CREATE OR REPLACE FUNCTION public.sec_detect_otp_abuse()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE cnt int; recent int;
BEGIN
  SELECT count(*) INTO cnt FROM public.phone_otp_verifications
    WHERE phone = NEW.phone AND created_at > now() - interval '15 minutes';
  IF cnt >= 5 THEN
    SELECT count(*) INTO recent FROM public.security_alerts
      WHERE category = 'otp_abuse' AND detail->>'phone' = NEW.phone AND created_at > now() - interval '15 minutes';
    IF recent = 0 THEN
      PERFORM public.raise_security_alert('high', 'otp_abuse',
        'OTP request burst for ' || NEW.phone || ' (' || cnt || ' in 15min)',
        jsonb_build_object('phone', NEW.phone, 'count_15min', cnt, 'purpose', NEW.purpose), NEW.phone);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_otp_abuse_trg ON public.phone_otp_verifications;
CREATE TRIGGER sec_detect_otp_abuse_trg AFTER INSERT ON public.phone_otp_verifications
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_otp_abuse();
