-- 0083_security_alerts_table.sql
--
-- Central store for the DB-level security alerting system. Every detector
-- (triggers in 0085, plus app-side) writes a row here; the AFTER INSERT delivery
-- trigger (0084) fans it out to admins in real time. Also serves as the durable
-- forensic trail the 2026-06-21 incident lacked (auth.audit_log_entries is empty).
--
-- RLS: service-role writes only; admins may read (for the /admin/security feed +
-- Supabase Realtime). Applied live via the Management API 2026-06-22.

CREATE TABLE IF NOT EXISTS public.security_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'info')),
  category text NOT NULL,
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'trigger',        -- trigger | cron | app
  actor text,                                    -- email / id / ip of the subject
  ip text,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  notified_at timestamptz,                       -- set when delivery is claimed
  channels_sent text[] NOT NULL DEFAULT '{}'::text[]
);

CREATE INDEX IF NOT EXISTS security_alerts_created_idx ON public.security_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS security_alerts_unnotified_idx ON public.security_alerts (created_at) WHERE notified_at IS NULL;

ALTER TABLE public.security_alerts ENABLE ROW LEVEL SECURITY;

-- Reads: admins only (browser client + Realtime). Writes: service-role only.
REVOKE ALL ON public.security_alerts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.security_alerts FROM authenticated;
GRANT SELECT ON public.security_alerts TO authenticated;

DROP POLICY IF EXISTS security_alerts_service_all ON public.security_alerts;
CREATE POLICY security_alerts_service_all ON public.security_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS security_alerts_admin_read ON public.security_alerts;
CREATE POLICY security_alerts_admin_read ON public.security_alerts
  FOR SELECT TO authenticated USING (public.get_current_user_role() = 'admin');

-- Live admin feed.
ALTER PUBLICATION supabase_realtime ADD TABLE public.security_alerts;
