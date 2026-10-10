-- SMS platform rebuild — Phase 1 foundation.
-- Spec: docs/superpowers/specs/2026-10-10-sms-platform-rebuild-phase1-design.md (§5.1, §5.2, §5.5, §5.5a)
-- One transaction. Ends with invariant assertions: any failure rolls the whole thing back.
BEGIN;

CREATE TEMP TABLE _sms_mig_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM sms_accounts)                                   AS accts,
       (SELECT COALESCE(sum(unit_balance), 0) FROM sms_accounts)             AS bal,
       (SELECT count(*) FROM sms_sender_ids)                                 AS sids,
       (SELECT count(*) FROM sms_sender_ids WHERE local_status = 'active')   AS active_ids;

-- ── sms_accounts ─────────────────────────────────────────────────────────────
ALTER TABLE sms_accounts
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fraud_flag_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_hold BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_rate_limit_override INT,
  ADD COLUMN IF NOT EXISTS default_sender_id UUID REFERENCES sms_sender_ids(id) ON DELETE SET NULL;
ALTER TABLE sms_accounts DROP CONSTRAINT IF EXISTS sms_accounts_mode_check;
ALTER TABLE sms_accounts ADD CONSTRAINT sms_accounts_mode_check CHECK (mode IN ('platform','business'));
ALTER TABLE sms_accounts DROP CONSTRAINT IF EXISTS sms_accounts_api_rate_limit_override_check;
ALTER TABLE sms_accounts ADD CONSTRAINT sms_accounts_api_rate_limit_override_check
  CHECK (api_rate_limit_override IS NULL OR api_rate_limit_override BETWEEN 1 AND 10000);
ALTER TABLE sms_accounts DROP CONSTRAINT IF EXISTS sms_accounts_owner_type_check;
ALTER TABLE sms_accounts ADD CONSTRAINT sms_accounts_owner_type_check
  CHECK (owner_type IN ('platform','shop','sub_agent','individual'));

-- ── sms_business_profiles (KYC) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_business_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sms_account_id        UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  business_name         TEXT CHECK (business_name IS NULL OR char_length(business_name) BETWEEN 2 AND 120),
  description           TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 10 AND 2000),
  website               TEXT,
  whatsapp_number       TEXT,
  ghana_card_last4      CHAR(4),
  ghana_card_doc_path   TEXT,
  registration_doc_path TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_at          TIMESTAMPTZ,
  reviewed_by           UUID,
  reviewed_at           TIMESTAMPTZ,
  rejection_reason      TEXT,
  docs_purge_after      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_business_profiles_open
  ON sms_business_profiles(sms_account_id) WHERE status IN ('draft','submitted');
CREATE INDEX IF NOT EXISTS idx_sms_business_profiles_status ON sms_business_profiles(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_sms_business_profiles_purge
  ON sms_business_profiles(docs_purge_after) WHERE docs_purge_after IS NOT NULL;
ALTER TABLE sms_business_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_business_profiles FROM anon, authenticated;

-- ── sms_sender_ids ───────────────────────────────────────────────────────────
ALTER TABLE sms_sender_ids DROP CONSTRAINT IF EXISTS sms_sender_ids_local_status_check;
ALTER TABLE sms_sender_ids ADD CONSTRAINT sms_sender_ids_local_status_check
  CHECK (local_status IN ('pending','active','rejected','paused','revoked'));
ALTER TABLE sms_sender_ids
  ADD COLUMN IF NOT EXISTS kyc_free BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_pool BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ── sms_bundles ──────────────────────────────────────────────────────────────
ALTER TABLE sms_bundles
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE sms_bundles DROP CONSTRAINT IF EXISTS sms_bundles_mode_check;
ALTER TABLE sms_bundles ADD CONSTRAINT sms_bundles_mode_check CHECK (mode IN ('platform','business'));
ALTER TABLE sms_bundles DROP CONSTRAINT IF EXISTS sms_bundles_owner_type_scope_check;
ALTER TABLE sms_bundles ADD CONSTRAINT sms_bundles_owner_type_scope_check
  CHECK (owner_type_scope IN ('all','shop','sub_agent','platform','individual'));

-- ── ledger: revenue + campaign link ──────────────────────────────────────────
ALTER TABLE sms_unit_transactions
  ADD COLUMN IF NOT EXISTS amount_ghs NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS send_log_id BIGINT REFERENCES sms_send_logs(id) ON DELETE SET NULL;
ALTER TABLE sms_pending_credits ADD COLUMN IF NOT EXISTS amount_ghs NUMERIC(12,2);

-- A pending purchase settles later via adjust_sms_units with the same ref; copy its amount.
CREATE OR REPLACE FUNCTION sms_unit_tx_copy_pending_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ref IS NOT NULL AND NEW.amount_ghs IS NULL THEN
    SELECT pc.amount_ghs INTO NEW.amount_ghs FROM sms_pending_credits pc WHERE pc.ref = NEW.ref LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sms_unit_tx_pending_amount ON sms_unit_transactions;
CREATE TRIGGER trg_sms_unit_tx_pending_amount BEFORE INSERT ON sms_unit_transactions
  FOR EACH ROW EXECUTE FUNCTION sms_unit_tx_copy_pending_amount();

-- ── sms_flags ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_flags (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sms_account_id UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  send_log_id    BIGINT REFERENCES sms_send_logs(id) ON DELETE SET NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('fraud','info')),
  reason         TEXT NOT NULL,
  matched        TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by    UUID,
  resolved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sms_flags_account_status ON sms_flags(sms_account_id, status);
CREATE INDEX IF NOT EXISTS idx_sms_flags_status_time ON sms_flags(status, created_at DESC);
ALTER TABLE sms_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_flags FROM anon, authenticated;

-- ── sms_send_logs ────────────────────────────────────────────────────────────
ALTER TABLE sms_send_logs DROP CONSTRAINT IF EXISTS sms_send_logs_status_check;
ALTER TABLE sms_send_logs ADD CONSTRAINT sms_send_logs_status_check
  CHECK (status IN ('queued','sending','sent','partial','failed','blocked','held','scheduled'));
ALTER TABLE sms_send_logs
  ADD COLUMN IF NOT EXISTS mode TEXT,
  ADD COLUMN IF NOT EXISTS policy_shadow JSONB,
  ADD COLUMN IF NOT EXISTS provider_batch_id TEXT;

-- ── sms_messages ─────────────────────────────────────────────────────────────
ALTER TABLE sms_messages
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_batch_id TEXT,
  ADD COLUMN IF NOT EXISTS cost_ghs NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS refunded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_delivery_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_delivery_status_check
  CHECK (delivery_status IN ('pending','delivered','failed'));
CREATE INDEX IF NOT EXISTS idx_sms_messages_provider_msg
  ON sms_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_messages_dlr_pending
  ON sms_messages(processed_at) WHERE provider = 'hubtel' AND status = 'sent' AND delivery_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sms_messages_hubtel_rate
  ON sms_messages(processed_at) WHERE provider = 'hubtel' AND cost_ghs IS NOT NULL;

-- ── private KYC bucket ───────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sms-kyc', 'sms-kyc', false, 5242880, ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- ── data migration (§5.2) ────────────────────────────────────────────────────
-- Platform owner (admin) accounts are platform traffic: business mode, keep every sender ID.
UPDATE sms_accounts SET mode = 'business', mode_changed_at = now() WHERE owner_type = 'platform';

-- Per tenant account: oldest active sender ID stays usable as the one KYC-free ID; others pause.
WITH ranked AS (
  SELECT s.id, row_number() OVER (PARTITION BY s.sms_account_id ORDER BY s.created_at, s.id) AS rn
  FROM sms_sender_ids s JOIN sms_accounts a ON a.id = s.sms_account_id
  WHERE s.local_status = 'active' AND a.owner_type <> 'platform'
)
UPDATE sms_sender_ids s
SET kyc_free     = (r.rn = 1),
    local_status = CASE WHEN r.rn = 1 THEN 'active' ELSE 'paused' END,
    updated_at   = now()
FROM ranked r WHERE s.id = r.id;

UPDATE sms_sender_ids SET approved_at = COALESCE(approved_at, updated_at)
WHERE local_status IN ('active','paused');

UPDATE sms_accounts a SET default_sender_id = s.id
FROM sms_sender_ids s
WHERE s.sms_account_id = a.id AND s.kyc_free AND s.local_status = 'active' AND a.default_sender_id IS NULL;

-- Global uniqueness of ACTIVE names (created after pausing).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_sender_ids_active_name
  ON sms_sender_ids (upper(sender_id)) WHERE local_status = 'active';

UPDATE sms_bundles b SET sort_order = r.rn
FROM (SELECT id, row_number() OVER (ORDER BY price_ghs, id) AS rn FROM sms_bundles) r
WHERE b.id = r.id;

-- Messages the drain already refunded (ref = message id).
UPDATE sms_messages m SET refunded = true, delivery_status = 'failed'
WHERE EXISTS (SELECT 1 FROM sms_unit_transactions t WHERE t.ref = m.id::text);

-- ── settings seed (tenant_global_settings, jsonb) ────────────────────────────
INSERT INTO tenant_global_settings (key, value) VALUES
  ('sms_feature_enabled',           'true'::jsonb),
  ('sms_policy_enforced',           'false'::jsonb),
  ('sms_allowed_roles',             '["shop_owner","sub_agent"]'::jsonb),
  ('sms_sender_pool',               '[]'::jsonb),
  ('sms_caps',                      '{"platform":{"per_send":300,"per_hour":20,"per_day":500},"business":{"per_send":1000,"per_hour":2000,"per_day":1000000}}'::jsonb),
  ('sms_blocked_keywords',          '[]'::jsonb),
  ('sms_business_blocked_keywords', '[]'::jsonb),
  ('sms_business_flagged_keywords', '[]'::jsonb),
  ('sms_business_allowed_domains',  '[]'::jsonb),
  ('sms_auto_suspend_flags',        '2'::jsonb),
  ('sms_flag_review_threshold',     '5'::jsonb),
  ('sms_api_rate_limit_default',    '30'::jsonb),
  ('sms_protected_sender_names',    '["MTN","TELECEL","VODAFONE","AIRTELTIGO","AIRTEL","TIGO","GLO","MOMO","MOBILEMONEY","HUBTEL","PAYSTACK","EXPRESSPAY","ZEEPAY","GCB","ECOBANK","STANBIC","ABSA","FIDELITY","CALBANK","ZENITH","ACCESSBANK","GTBANK","UBA","SOCGEN","REPUBLICBANK","PRUDENTIAL","ADB","NIB","CBG","OMNIBSIC","FIRSTBANK","BANKOFGHANA","BOG","GRA","ECG","GWCL","NHIS","NIA","DVLA","GHANAPOST","POLICE","GHANAGOV","WAEC","DATAGOD"]'::jsonb),
  ('sms_hubtel_cost_per_sms',       '0.035'::jsonb),
  ('sms_hubtel_low_balance_ghs',    '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── SQL functions (§5.5) ─────────────────────────────────────────────────────
-- Mark dispatched rows sent, with provider ids, in one round trip.
CREATE OR REPLACE FUNCTION mark_sms_messages_sent(p_provider TEXT, p_rows JSONB)
RETURNS INT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (
    UPDATE sms_messages m
    SET status = 'sent', provider = p_provider, processed_at = now(),
        provider_message_id = x.mid, provider_batch_id = x.bid
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, mid TEXT, bid TEXT)
    WHERE m.id = x.id AND m.status IN ('pending','claimed')
    RETURNING 1
  )
  SELECT count(*)::int FROM u;
$$;

-- Refund one message's credits exactly once (ref = message id, shared with the drain).
CREATE OR REPLACE FUNCTION refund_sms_message(p_message_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m RECORD;
  v_ref TEXT := p_message_id::text;
BEGIN
  SELECT id, sms_account_id, segments, send_log_id, refunded INTO m
  FROM sms_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR m.refunded THEN RETURN false; END IF;

  IF EXISTS (SELECT 1 FROM sms_unit_transactions WHERE ref = v_ref) THEN
    UPDATE sms_messages SET refunded = true, delivery_status = 'failed' WHERE id = p_message_id;
    RETURN false;
  END IF;

  PERFORM adjust_sms_units(m.sms_account_id, m.segments, 'campaign_refund', v_ref);
  UPDATE sms_unit_transactions SET send_log_id = m.send_log_id WHERE ref = v_ref;
  UPDATE sms_messages SET refunded = true, delivery_status = 'failed' WHERE id = p_message_id;
  RETURN true;
END $$;

-- Apply polled delivery reports. p_rows: [{mid, state: delivered|failed|pending, rate, at}]
CREATE OR REPLACE FUNCTION apply_sms_delivery_reports(p_rows JSONB)
RETURNS TABLE(out_message_id UUID, out_send_log_id BIGINT, out_outcome TEXT, out_refunded BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  x RECORD;
  m RECORD;
BEGIN
  FOR x IN SELECT * FROM jsonb_to_recordset(p_rows) AS t(mid TEXT, state TEXT, rate NUMERIC, at TIMESTAMPTZ) LOOP
    IF x.state NOT IN ('delivered','failed') THEN
      UPDATE sms_messages SET cost_ghs = COALESCE(x.rate, cost_ghs)
      WHERE provider_message_id = x.mid AND delivery_status = 'pending';
      CONTINUE;
    END IF;
    FOR m IN SELECT id, send_log_id FROM sms_messages
             WHERE provider_message_id = x.mid AND delivery_status = 'pending' FOR UPDATE LOOP
      UPDATE sms_messages
      SET delivery_status = x.state,
          delivered_at = CASE WHEN x.state = 'delivered' THEN COALESCE(x.at, now()) END,
          cost_ghs = COALESCE(x.rate, cost_ghs)
      WHERE id = m.id;
      out_message_id := m.id;
      out_send_log_id := m.send_log_id;
      out_outcome := x.state;
      out_refunded := CASE WHEN x.state = 'failed' THEN refund_sms_message(m.id) ELSE false END;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END $$;

-- Delivery-aware campaign rollup. Never touches held/scheduled/blocked logs.
CREATE OR REPLACE FUNCTION recompute_sms_send_result(p_send_log_id BIGINT, max_attempts INT DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_ok INT; v_failed_final INT; v_outstanding INT; v_used INT;
BEGIN
  SELECT
    count(*) FILTER (WHERE status = 'sent' AND delivery_status <> 'failed'),
    count(*) FILTER (WHERE (status = 'failed' AND attempts >= max_attempts) OR delivery_status = 'failed'),
    count(*) FILTER (WHERE status IN ('pending','claimed') OR (status = 'failed' AND attempts < max_attempts)),
    COALESCE(sum(segments) FILTER (WHERE status = 'sent' AND NOT refunded), 0)
  INTO v_ok, v_failed_final, v_outstanding, v_used
  FROM sms_messages WHERE send_log_id = p_send_log_id;

  UPDATE sms_send_logs
  SET credits_used = v_used,
      status = CASE
        WHEN v_outstanding > 0  THEN 'sending'
        WHEN v_ok = 0           THEN 'failed'
        WHEN v_failed_final > 0 THEN 'partial'
        ELSE 'sent'
      END,
      completed_at = CASE WHEN v_outstanding = 0 THEN now() ELSE NULL END
  WHERE id = p_send_log_id AND status NOT IN ('held','scheduled','blocked');
END $$;

REVOKE ALL ON FUNCTION mark_sms_messages_sent(TEXT, JSONB)       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mark_sms_messages_sent(TEXT, JSONB)   TO service_role;
REVOKE ALL ON FUNCTION refund_sms_message(UUID)                  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION refund_sms_message(UUID)              TO service_role;
REVOKE ALL ON FUNCTION apply_sms_delivery_reports(JSONB)         FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION apply_sms_delivery_reports(JSONB)     TO service_role;
REVOKE ALL ON FUNCTION recompute_sms_send_result(BIGINT, INT)    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION recompute_sms_send_result(BIGINT, INT) TO service_role;

-- ── invariants (§5.2) — any failure aborts the whole migration ───────────────
DO $$
DECLARE b RECORD;
BEGIN
  SELECT * INTO b FROM _sms_mig_before;
  IF (SELECT count(*) FROM sms_accounts) <> b.accts THEN
    RAISE EXCEPTION 'invariant: sms_accounts count changed'; END IF;
  IF (SELECT COALESCE(sum(unit_balance), 0) FROM sms_accounts) <> b.bal THEN
    RAISE EXCEPTION 'invariant: total unit_balance changed'; END IF;
  IF (SELECT count(*) FROM sms_sender_ids) <> b.sids THEN
    RAISE EXCEPTION 'invariant: sender id rows changed'; END IF;
  IF (SELECT count(*) FROM sms_sender_ids WHERE local_status IN ('active','paused')) <> b.active_ids THEN
    RAISE EXCEPTION 'invariant: active ids not all kept or paused'; END IF;
  IF EXISTS (SELECT 1 FROM sms_sender_ids s JOIN sms_accounts a ON a.id = s.sms_account_id
             WHERE a.owner_type <> 'platform' AND s.local_status = 'active' AND NOT s.kyc_free) THEN
    RAISE EXCEPTION 'invariant: tenant has an active non-kyc_free sender id'; END IF;
  IF EXISTS (SELECT sms_account_id FROM sms_sender_ids WHERE kyc_free GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'invariant: more than one kyc_free id per account'; END IF;
  IF EXISTS (SELECT 1 FROM sms_accounts WHERE owner_type <> 'platform' AND mode <> 'platform') THEN
    RAISE EXCEPTION 'invariant: tenant account not in platform mode'; END IF;
  IF (SELECT value FROM tenant_global_settings WHERE key = 'sms_policy_enforced') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'invariant: sms_policy_enforced must be false'; END IF;
END $$;

COMMIT;
