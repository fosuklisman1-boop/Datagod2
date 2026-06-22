-- 0084_security_alerts_delivery.sql
--
-- Central alert-raising helper + real-time delivery for the DB-level security
-- alerting system (table created in 0083). On every security_alerts INSERT we
-- fire pg_net.http_post to the app's /api/internal/security-alert endpoint,
-- which fans the alert out to admins (WhatsApp/SMS/email/in-app) by severity.
-- Delivery is best-effort and NEVER blocks the originating write; a Vercel cron
-- (0086 / app) drains any alert whose notified_at is still NULL.
--
-- The shared webhook secret lives in public.internal_config (service-role-only,
-- read by the SECURITY DEFINER notify fn) — seeded live, NOT committed here.
-- Applied live via the Management API 2026-06-22.

-- Service-role-only key/value store for DB-internal secrets (webhook secret etc.)
CREATE TABLE IF NOT EXISTS public.internal_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.internal_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.internal_config FROM anon, authenticated;
-- No authenticated/anon policy => unreadable by them. service_role bypasses RLS;
-- SECURITY DEFINER functions (owned by postgres) read it regardless.

-- Central helper every detector calls to record an alert.
CREATE OR REPLACE FUNCTION public.raise_security_alert(
  p_severity text,
  p_category text,
  p_title text,
  p_detail jsonb DEFAULT '{}'::jsonb,
  p_actor text DEFAULT NULL,
  p_ip text DEFAULT NULL,
  p_source text DEFAULT 'trigger'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $f$
DECLARE aid uuid;
BEGIN
  INSERT INTO public.security_alerts(severity, category, title, detail, actor, ip, source)
  VALUES (p_severity, p_category, p_title, COALESCE(p_detail, '{}'::jsonb), p_actor, p_ip, p_source)
  RETURNING id INTO aid;
  RETURN aid;
END;
$f$;
REVOKE EXECUTE ON FUNCTION public.raise_security_alert(text,text,text,jsonb,text,text,text) FROM anon, authenticated;

-- Real-time delivery: POST the alert id to the app on insert. Wrapped so a
-- delivery failure can never roll back / block the alert (or the original write).
CREATE OR REPLACE FUNCTION public.security_alert_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $f$
DECLARE v_secret text;
BEGIN
  SELECT value INTO v_secret FROM public.internal_config WHERE key = 'security_alert_secret';
  PERFORM net.http_post(
    url := 'https://www.datagod.store/api/internal/security-alert',
    body := jsonb_build_object('alert_id', NEW.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', COALESCE(v_secret, '')),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$f$;

DROP TRIGGER IF EXISTS security_alerts_notify_trg ON public.security_alerts;
CREATE TRIGGER security_alerts_notify_trg
  AFTER INSERT ON public.security_alerts
  FOR EACH ROW EXECUTE FUNCTION public.security_alert_notify();
