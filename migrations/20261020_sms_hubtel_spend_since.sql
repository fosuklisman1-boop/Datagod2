-- Manual Hubtel balance (design 2026-10-12 §B): exact Hubtel SMS spend since the admin entered a
-- balance, so the solvency gate can estimate the live Disbursement balance while the relay /balance
-- is blocked. estimate = manual amount − sms_hubtel_spend_since(setAt, rate)   (floored at 0, app-side)
--
-- Counted: sms_messages rows sent via Hubtel (provider = 'hubtel'), not refunded, not failed, created
-- OR sent at/after p_since. A message queued before the balance was read but sent after it was NOT
-- reflected in that balance, so it must count too (provider/processed_at are set together on send).
-- Cost per row: the delivery-report cost_ghs when present, else segments × p_default_rate (the app
-- passes the highest observed Hubtel rate, else the configured cost) — conservative.
-- Bad inputs raise instead of returning 0: the caller fails CLOSED on any error.
-- Read-only, SECURITY DEFINER, service_role only. NOT applied automatically.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION sms_hubtel_spend_since(p_since timestamptz, p_default_rate numeric)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total numeric;
BEGIN
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'sms_hubtel_spend_since: p_since is required';
  END IF;
  IF p_default_rate IS NULL OR p_default_rate <= 0 THEN
    RAISE EXCEPTION 'sms_hubtel_spend_since: p_default_rate must be > 0';
  END IF;

  SELECT COALESCE(sum(COALESCE(m.cost_ghs, m.segments * p_default_rate)), 0)
    INTO v_total
    FROM sms_messages m
   WHERE m.provider = 'hubtel'
     AND NOT m.refunded
     AND m.status <> 'failed'
     AND (m.created_at >= p_since OR m.processed_at >= p_since);

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION sms_hubtel_spend_since(timestamptz, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_hubtel_spend_since(timestamptz, numeric) TO service_role;

COMMIT;
