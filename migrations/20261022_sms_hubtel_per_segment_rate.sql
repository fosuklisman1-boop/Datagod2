-- Hubtel's reported `rate` (stored as sms_messages.cost_ghs by the DLR poller) is the TOTAL price of
-- the whole MESSAGE, not a per-segment rate. Verified live 2026-10-13 from 432 settled messages:
-- segments = 1 → cost_ghs 0.0243 (110 rows); segments = 2 → cost_ghs 0.0486 (322 rows).
-- Per-segment (per-part) price = cost_ghs / segments = 0.0243.
--
-- 1. sms_hubtel_max_rate(p_days): the highest observed PER-SEGMENT price in the window
--    (max(cost_ghs / segments)); the solvency gate divides the balance by it. NULL when nothing
--    was observed (the app then uses the configured sms_hubtel_cost_per_sms, also per segment).
-- 2. sms_hubtel_spend_since: the sms_messages arm now prices each row as
--    GREATEST(COALESCE(cost_ghs, 0), segments × p_default_rate) — cost_ghs is already the whole
--    message price; the floor at segments × the per-segment default keeps unknown/low reports from
--    under-counting. Everything else is byte-identical to the applied 20261020 definition.
--
-- Read-only, SECURITY DEFINER, service_role only. NOT applied automatically.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION sms_hubtel_max_rate(p_days int)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max(m.cost_ghs / m.segments)
    FROM sms_messages m
   WHERE m.provider = 'hubtel'
     AND m.cost_ghs IS NOT NULL
     AND m.segments > 0
     AND m.processed_at >= now() - make_interval(days => GREATEST(p_days, 1));
$$;

REVOKE ALL ON FUNCTION sms_hubtel_max_rate(int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_hubtel_max_rate(int) TO service_role;

-- Spend scan support for the sms_messages arm (table is small today).
CREATE INDEX IF NOT EXISTS idx_sms_messages_hubtel_sent
  ON sms_messages (processed_at) INCLUDE (segments, cost_ghs)
  WHERE provider = 'hubtel' AND status = 'sent';

CREATE OR REPLACE FUNCTION sms_hubtel_spend_since(p_since timestamptz, p_default_rate numeric)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_messages numeric;
  v_logs     numeric;
BEGIN
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'sms_hubtel_spend_since: p_since is required';
  END IF;
  IF p_default_rate IS NULL OR p_default_rate <= 0 THEN
    RAISE EXCEPTION 'sms_hubtel_spend_since: p_default_rate must be > 0';
  END IF;

  SELECT COALESCE(sum(GREATEST(COALESCE(m.cost_ghs, 0), m.segments * p_default_rate)), 0)
    INTO v_messages
    FROM sms_messages m
   WHERE m.provider = 'hubtel'
     AND m.status = 'sent'
     AND m.processed_at >= p_since;

  SELECT COALESCE(sum(p_default_rate * GREATEST(1, ceil(length(l.message)::numeric
           / CASE WHEN octet_length(l.message) > length(l.message) THEN 67 ELSE 153 END))), 0)
    INTO v_logs
    FROM sms_logs l
   WHERE l.provider = 'hubtel'
     AND l.status IN ('sent', 'delivered')
     AND l.message_type IS DISTINCT FROM 'shop_sms'
     AND l.created_at >= (p_since AT TIME ZONE 'UTC');

  RETURN v_messages + v_logs;
END;
$$;

REVOKE ALL ON FUNCTION sms_hubtel_spend_since(timestamptz, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_hubtel_spend_since(timestamptz, numeric) TO service_role;

COMMIT;
