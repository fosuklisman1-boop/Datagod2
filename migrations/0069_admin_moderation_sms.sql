-- migrations/0069_admin_moderation_sms.sql
-- Bulk SMS Milestone 4: admin moderation.
--   admin_audit_log         : records privileged admin actions (suspend/unsuspend, flag dismiss)
--   suspend_sms_account     : atomically toggle sms_accounts.status active<->suspended (never inactive)
--   get_sms_revenue_summary : aggregate revenue for the admin dashboard
-- Both functions are SECURITY DEFINER and locked to service_role (a tenant must NOT be able to
-- un-suspend their own account or read platform revenue) — applying the M3 review's security lesson.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        UUID        NOT NULL REFERENCES auth.users(id),
  action          TEXT        NOT NULL,            -- 'sms_suspend' | 'sms_unsuspend' | 'sms_flag_dismiss'
  target_user_id  UUID        REFERENCES auth.users(id),
  old_value       JSONB,
  new_value       JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin  ON admin_audit_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON admin_audit_log(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log(action, created_at DESC);

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_audit_log_admin_select ON admin_audit_log;
CREATE POLICY admin_audit_log_admin_select ON admin_audit_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));
GRANT SELECT ON admin_audit_log TO authenticated;
GRANT ALL    ON admin_audit_log TO service_role;

-- ── suspend_sms_account: toggle active<->suspended atomically (never touches 'inactive') ──
CREATE OR REPLACE FUNCTION suspend_sms_account(
  p_account_id UUID,
  p_suspended  BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current TEXT;
  v_new     TEXT;
BEGIN
  SELECT status INTO v_current FROM sms_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sms_account % not found', p_account_id USING ERRCODE = 'P0003';
  END IF;
  IF v_current = 'inactive' THEN
    RAISE EXCEPTION 'cannot suspend/unsuspend an inactive account' USING ERRCODE = 'P0001';
  END IF;

  v_new := CASE WHEN p_suspended THEN 'suspended' ELSE 'active' END;
  IF v_current = v_new THEN
    RETURN v_new;  -- idempotent no-op
  END IF;

  UPDATE sms_accounts SET status = v_new, updated_at = now() WHERE id = p_account_id;
  RETURN v_new;
END;
$$;

-- ── get_sms_revenue_summary: aggregate dashboard numbers (read-only) ─────────
-- bundleGhsTotal is approximate (0) for now: per-bundle GHS isn't stored on
-- sms_unit_transactions (only activation amount_paid is exact). Documented limitation.
CREATE OR REPLACE FUNCTION get_sms_revenue_summary()
RETURNS TABLE(
  "activationCount"  BIGINT,
  "activationTotal"  NUMERIC,
  "bundleUnitsSold"  BIGINT,
  "bundleGhsTotal"   NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH activation_agg AS (
    SELECT COUNT(*) AS act_count, COALESCE(SUM(amount_paid), 0) AS act_total
    FROM sms_accounts
    WHERE amount_paid IS NOT NULL AND amount_paid > 0
  ),
  bundle_agg AS (
    SELECT COALESCE(SUM(delta), 0) AS units_sold, 0::NUMERIC AS ghs_total
    FROM sms_unit_transactions
    WHERE reason IN ('bundle_wallet', 'bundle_paystack') AND delta > 0
  )
  SELECT act_count::BIGINT, act_total, units_sold::BIGINT, ghs_total
  FROM activation_agg, bundle_agg;
$$;

-- Lock both functions to the backend service identity (REVOKE the default PUBLIC grant).
REVOKE ALL ON FUNCTION suspend_sms_account(UUID, BOOLEAN)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION suspend_sms_account(UUID, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION get_sms_revenue_summary()           FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION get_sms_revenue_summary()        TO service_role;
