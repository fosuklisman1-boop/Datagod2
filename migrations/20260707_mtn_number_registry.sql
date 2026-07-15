-- MTN number registration pipeline (Phase 1).
-- MTN only fulfills data to pre-registered numbers. This creates a stateful
-- registry (pending -> submitted -> registered), auto-captures every new MTN
-- data-order beneficiary via AFTER INSERT triggers (all channels, incl. the
-- place_api_order SECURITY DEFINER path that code hooks would miss), seeds it
-- from every MTN number we already know, and provides an atomic claim RPC for
-- the admin delta export. Conventions mirror 20260615_wa_delivery_outbox.sql.
-- Depends on: normalize_gh_phone(text) from 20260707_all_order_phones.sql.

-- 1. Registry ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mtn_number_registry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE,          -- canonical 0XXXXXXXXX
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','submitted','registered','rejected')),
  source          text,                          -- 'order:<table>' | 'seed:<source>'
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at    timestamptz,
  submitted_batch uuid,
  registered_at   timestamptz,
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mtn_number_registry_status_idx ON mtn_number_registry (status);

ALTER TABLE mtn_number_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mtn_registry_service_only ON mtn_number_registry;
CREATE POLICY mtn_registry_service_only ON mtn_number_registry
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON mtn_number_registry FROM anon, authenticated;
GRANT ALL ON mtn_number_registry TO service_role;

-- 2. Batches ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mtn_registration_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_time          timestamptz NOT NULL DEFAULT now(),
  phones              jsonb NOT NULL,            -- ["0XXXXXXXXX", ...] for re-download
  number_count        integer NOT NULL,
  status              text NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted','registered')),
  downloaded_by       uuid,
  downloaded_by_email text,
  registered_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mtn_registration_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mtn_batches_service_only ON mtn_registration_batches;
CREATE POLICY mtn_batches_service_only ON mtn_registration_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON mtn_registration_batches FROM anon, authenticated;
GRANT ALL ON mtn_registration_batches TO service_role;

-- 3. MTN prefix helper (mirrors detectGhanaNetwork in lib/phone-format.ts) ---
CREATE OR REPLACE FUNCTION gh_is_mtn(raw text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    substring(normalize_gh_phone(raw) FROM 2 FOR 2) IN ('24','25','53','54','55','59'),
    false
  );
$$;
REVOKE ALL ON FUNCTION gh_is_mtn(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gh_is_mtn(text) TO service_role;

-- 4. Capture trigger: every new MTN data order enrolls its beneficiary ------
CREATE OR REPLACE FUNCTION capture_mtn_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER                 -- insert succeeds regardless of writer's role
SET search_path = public
AS $$
DECLARE
  j    jsonb := to_jsonb(NEW);
  raw  text;
  norm text;
BEGIN
  IF lower(COALESCE(j->>'network','')) <> 'mtn' THEN
    RETURN NEW;
  END IF;
  raw := CASE TG_TABLE_NAME
    WHEN 'orders'      THEN j->>'phone_number'
    WHEN 'shop_orders' THEN j->>'customer_phone'
    ELSE                    j->>'recipient_phone'   -- api_orders / ussd_orders / ussd_shop_orders
  END;
  norm := normalize_gh_phone(raw);
  IF norm IS NULL THEN
    RETURN NEW;
  END IF;
  -- Never revives a registered/rejected row; idempotent on repeat orders.
  INSERT INTO mtn_number_registry (phone, source)
  VALUES (norm, 'order:' || TG_TABLE_NAME)
  ON CONFLICT (phone) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;                    -- best-effort: never break the order write
END;
$$;
REVOKE ALL ON FUNCTION capture_mtn_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_capture_mtn_orders            ON orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_shop_orders       ON shop_orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_api_orders        ON api_orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_ussd_orders       ON ussd_orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_ussd_shop_orders  ON ussd_shop_orders;
CREATE TRIGGER trg_capture_mtn_orders           AFTER INSERT ON orders           FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_shop_orders      AFTER INSERT ON shop_orders      FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_api_orders       AFTER INSERT ON api_orders       FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_ussd_orders      AFTER INSERT ON ussd_orders      FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_ussd_shop_orders AFTER INSERT ON ussd_shop_orders FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();

-- 5. Atomic claim RPC for the delta export ----------------------------------
-- Claims ALL currently-pending numbers into a new batch in one transaction.
-- Two concurrent admins can never double-claim (row updates serialize) or
-- create a phantom batch (0 claimed -> no batch row).
CREATE OR REPLACE FUNCTION claim_mtn_registration_batch(p_admin_id uuid, p_admin_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id uuid := gen_random_uuid();
  v_phones   jsonb;
  v_count    integer;
BEGIN
  WITH claimed AS (
    UPDATE mtn_number_registry
    SET status = 'submitted',
        submitted_at = now(),
        submitted_batch = v_batch_id,
        updated_at = now()
    WHERE status = 'pending'
    RETURNING phone, first_seen_at
  )
  SELECT COALESCE(jsonb_agg(phone ORDER BY first_seen_at), '[]'::jsonb), COUNT(*)
  INTO v_phones, v_count
  FROM claimed;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('batch_id', NULL, 'count', 0, 'phones', '[]'::jsonb);
  END IF;

  INSERT INTO mtn_registration_batches (id, phones, number_count, status, downloaded_by, downloaded_by_email)
  VALUES (v_batch_id, v_phones, v_count, 'submitted', p_admin_id, p_admin_email);

  RETURN jsonb_build_object('batch_id', v_batch_id, 'count', v_count, 'phones', v_phones);
END;
$$;
REVOKE ALL ON FUNCTION claim_mtn_registration_batch(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_mtn_registration_batch(uuid, text) TO service_role;

-- 6. Seed / backfill (idempotent; safe to re-run) ----------------------------
-- 6a. Order buyers with an explicit MTN order (definite MTN).
INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT phone, 'seed:orders'
FROM all_order_phones
WHERE network_raw = 'MTN' AND phone IS NOT NULL
ON CONFLICT (phone) DO NOTHING;

-- 6b. Phone-verification results marked MTN (verified network).
INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:phone_verify'
FROM phone_verification_results
WHERE UPPER(COALESCE(network,'')) = 'MTN'
  AND normalize_gh_phone(phone_number) IS NOT NULL
ON CONFLICT (phone) DO NOTHING;

-- 6c. Prefix-MTN numbers from every other contact source we hold.
--     (Heuristic: portability means a few may not be MTN; MTN simply won't
--      register those. Order-capture above is exact.)
INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:users'
FROM users
WHERE gh_is_mtn(phone_number)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:whatsapp'
FROM whatsapp_conversations
WHERE gh_is_mtn(phone_number)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:sms_contacts'
FROM sms_contacts
WHERE gh_is_mtn(phone_number)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone), 'seed:sms_messages'
FROM sms_messages
WHERE gh_is_mtn(phone)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone), 'seed:broadcast'
FROM broadcast_recipients
WHERE phone IS NOT NULL AND gh_is_mtn(phone)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone), 'seed:otp'
FROM phone_otp_verifications
WHERE gh_is_mtn(phone)
ON CONFLICT (phone) DO NOTHING;
