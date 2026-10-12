-- Manual Hubtel balance (design 2026-10-12 §B): Hubtel SMS spend since the admin entered a balance,
-- so the solvency gate can estimate the live Disbursement balance while the relay /balance is
-- blocked. estimate = manual amount − sms_hubtel_spend_since(setAt, rate)   (floored at 0, app-side)
--
-- Conservative by construction (the estimate must never be too HIGH):
--  * sms_messages (customer campaigns, drained/dispatched): every row Hubtel accepted
--    (provider = 'hubtel' AND status = 'sent'; a sent row always has processed_at) sent at/after
--    p_since. `refunded` is NOT excluded: it means the customer's units were returned, Hubtel still
--    charged us. Priced segments × GREATEST(COALESCE(cost_ghs, 0), p_default_rate), which is safe
--    whether Hubtel's reported rate is per message or per segment.
--  * sms_logs (sendSMS(): OTPs, order/transactional SMS, admin broadcasts): Hubtel rows logged
--    'sent' (or later 'delivered'), EXCEPT message_type 'shop_sms' — those are the drain's sends,
--    already counted via sms_messages. NULL message_type is counted (IS DISTINCT FROM).
--    sms_logs.created_at is `timestamp WITHOUT time zone` written with now() in the session time
--    zone (UTC on Supabase), so p_since is converted to UTC wall-clock for the comparison.
--    No per-row cost is stored, so each row is priced p_default_rate × estimated segments:
--    ceil(length / 153) for ASCII text, ceil(length / 67) when any non-ASCII character is present
--    (UCS-2; detected as octet_length > length in the UTF-8 database), minimum 1. 153 also prices
--    a 154–160-char single SMS as 2 parts — deliberately on the high side. OTP bodies are stored redacted ("[OTP code redacted]") → 1 segment.
--  NOT counted (documented in the admin UI): sends made with skipLogging (admin notify,
--  notify-self, AI tasks, broadcast retries) and anything sent outside the app.
--
-- p_default_rate: the highest observed Hubtel rate, else the configured cost (app-side).
-- Bad inputs raise instead of returning 0: the caller fails CLOSED on any error.
-- Read-only, SECURITY DEFINER, service_role only. NOT applied automatically.

BEGIN;
SET LOCAL lock_timeout = '5s';

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

  SELECT COALESCE(sum(m.segments * GREATEST(COALESCE(m.cost_ghs, 0), p_default_rate)), 0)
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
