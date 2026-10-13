-- 0119_commission_cashback.sql
-- Commission cashback Part 1: config RPC, order snapshot columns, paid-amount debits, margin report.
-- ADDITIVE; service-role only. NOT applied by the implementing agent.

-- Atomic merge into admin_settings['commission_cashback_config']; top-level keys replace,
-- "surfaces", "rates" and "shares" merge one level.
CREATE OR REPLACE FUNCTION commission_cashback_config_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  INSERT INTO admin_settings (key, value, description, updated_at)
  VALUES ('commission_cashback_config', '{}'::jsonb, 'Commission cashback: master/surface switches, provider rates, shares.', now())
  ON CONFLICT (key) DO NOTHING;

  UPDATE admin_settings
     SET value = (COALESCE(value, '{}'::jsonb) || (p_patch - 'surfaces' - 'rates' - 'shares'))
                 || CASE WHEN jsonb_typeof(p_patch -> 'surfaces') = 'object'
                         THEN jsonb_build_object('surfaces', COALESCE(value -> 'surfaces', '{}'::jsonb) || (p_patch -> 'surfaces'))
                         ELSE '{}'::jsonb END
                 || CASE WHEN jsonb_typeof(p_patch -> 'rates') = 'object'
                         THEN jsonb_build_object('rates', COALESCE(value -> 'rates', '{}'::jsonb) || (p_patch -> 'rates'))
                         ELSE '{}'::jsonb END
                 || CASE WHEN jsonb_typeof(p_patch -> 'shares') = 'object'
                         THEN jsonb_build_object('shares', COALESCE(value -> 'shares', '{}'::jsonb) || (p_patch -> 'shares'))
                         ELSE '{}'::jsonb END,
         updated_at = now()
   WHERE key = 'commission_cashback_config'
  RETURNING value INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION commission_cashback_config_patch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION commission_cashback_config_patch(jsonb) TO service_role;

-- Snapshot columns on the three order tables (all nullable; NULL = no cashback applied).
ALTER TABLE airtime_orders
  ADD COLUMN IF NOT EXISTS cashback_amount     numeric(12,2),
  ADD COLUMN IF NOT EXISTS shop_share_amount   numeric(12,2),
  ADD COLUMN IF NOT EXISTS cashback_rate       numeric(6,3),
  ADD COLUMN IF NOT EXISTS cashback_share      numeric(6,2),
  ADD COLUMN IF NOT EXISTS cashback_provider   text,
  ADD COLUMN IF NOT EXISTS expected_commission numeric(12,4);

ALTER TABLE hubtel_bill_orders
  ADD COLUMN IF NOT EXISTS cashback_amount     numeric(12,2),
  ADD COLUMN IF NOT EXISTS shop_share_amount   numeric(12,2),
  ADD COLUMN IF NOT EXISTS cashback_rate       numeric(6,3),
  ADD COLUMN IF NOT EXISTS cashback_share      numeric(6,2),
  ADD COLUMN IF NOT EXISTS cashback_provider   text,
  ADD COLUMN IF NOT EXISTS expected_commission numeric(12,4),
  ADD COLUMN IF NOT EXISTS paid_amount         numeric(12,2) CHECK (paid_amount IS NULL OR paid_amount > 0);

ALTER TABLE hubtel_data_orders
  ADD COLUMN IF NOT EXISTS cashback_amount     numeric(12,2),
  ADD COLUMN IF NOT EXISTS shop_share_amount   numeric(12,2),
  ADD COLUMN IF NOT EXISTS cashback_rate       numeric(6,3),
  ADD COLUMN IF NOT EXISTS cashback_share      numeric(6,2),
  ADD COLUMN IF NOT EXISTS cashback_provider   text,
  ADD COLUMN IF NOT EXISTS expected_commission numeric(12,4),
  ADD COLUMN IF NOT EXISTS paid_amount         numeric(12,2) CHECK (paid_amount IS NULL OR paid_amount > 0);

-- Wallet debit for a bill order: deducts COALESCE(paid_amount, amount) (identical to 0117 when paid_amount is NULL).
CREATE OR REPLACE FUNCTION bill_order_debit(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE o hubtel_bill_orders%ROWTYPE; d record; v_pay numeric;
BEGIN
  SELECT * INTO o FROM hubtel_bill_orders
   WHERE id = p_order_id AND status = 'pending' AND payment_status = 'unpaid' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  v_pay := COALESCE(o.paid_amount, o.amount);

  SELECT * INTO d FROM deduct_wallet(o.user_id, v_pay);
  IF NOT FOUND THEN RETURN 'insufficient'; END IF;

  UPDATE hubtel_bill_orders SET payment_status = 'paid', updated_at = now() WHERE id = o.id;

  INSERT INTO transactions (user_id, type, source, amount, balance_before, balance_after, description, reference_id, status, created_at)
  VALUES (o.user_id, 'debit', 'utility_bill', v_pay, d.old_balance, d.new_balance,
          'Utility bill: ' || o.biller || ' ' || o.account_number, o.reference_code, 'completed', now());
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION bill_order_debit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bill_order_debit(uuid) TO service_role;

-- Wallet debit for a data order: deducts COALESCE(paid_amount, amount) (identical to 0118 when paid_amount is NULL).
CREATE OR REPLACE FUNCTION data_order_debit(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE o hubtel_data_orders%ROWTYPE; d record; v_pay numeric;
BEGIN
  SELECT * INTO o FROM hubtel_data_orders
   WHERE id = p_order_id AND status = 'pending' AND payment_status = 'unpaid' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  v_pay := COALESCE(o.paid_amount, o.amount);

  SELECT * INTO d FROM deduct_wallet(o.user_id, v_pay);
  IF NOT FOUND THEN RETURN 'insufficient'; END IF;

  UPDATE hubtel_data_orders SET payment_status = 'paid', updated_at = now() WHERE id = o.id;

  INSERT INTO transactions (user_id, type, source, amount, balance_before, balance_after, description, reference_id, status, created_at)
  VALUES (o.user_id, 'debit', 'standard_bundle', v_pay, d.old_balance, d.new_balance,
          'Standard bundle: ' || o.network || ' ' || o.bundle_display || ' to ' || o.beneficiary_phone, o.reference_code, 'completed', now());
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION data_order_debit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION data_order_debit(uuid) TO service_role;

-- Margin report: Hubtel's actual commission vs. cashback / shop share given out, per service and provider.
CREATE OR REPLACE FUNCTION cashback_margin_report(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(service_key text, provider text, orders bigint, face_total numeric, actual_commission numeric,
              cashback_total numeric, shop_share_total numeric, expected_commission numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH actual AS (
    SELECT t.service_key AS service_key, 'hubtel'::text AS provider,
           count(*) AS orders, COALESCE(sum(t.amount), 0)::numeric AS face_total,
           COALESCE(sum(t.commission), 0)::numeric AS actual_commission
      FROM hubtel_cs_transactions t
     WHERE t.state = 'fulfilled' AND t.completed_at >= p_from AND t.completed_at <= p_to
     GROUP BY t.service_key
  ),
  given_all AS (
    SELECT 'airtime_' || CASE a.network
             WHEN 'MTN' THEN 'mtn'
             WHEN 'Telecel' THEN 'telecel'
             WHEN 'AirtelTigo' THEN 'at'
             WHEN 'AT' THEN 'at'
             ELSE lower(a.network)
           END AS service_key,
           COALESCE(a.cashback_provider, 'hubtel') AS provider,
           a.cashback_amount, a.shop_share_amount, a.expected_commission
      FROM airtime_orders a
     WHERE a.status = 'completed' AND a.created_at >= p_from AND a.created_at <= p_to
    UNION ALL
    SELECT 'bill_' || b.biller, COALESCE(b.cashback_provider, 'hubtel'),
           b.cashback_amount, b.shop_share_amount, b.expected_commission
      FROM hubtel_bill_orders b
     WHERE b.status = 'completed' AND b.created_at >= p_from AND b.created_at <= p_to
    UNION ALL
    SELECT d.service_key, COALESCE(d.cashback_provider, 'hubtel'),
           d.cashback_amount, d.shop_share_amount, d.expected_commission
      FROM hubtel_data_orders d
     WHERE d.status = 'completed' AND d.created_at >= p_from AND d.created_at <= p_to
  ),
  given AS (
    SELECT g.service_key, g.provider,
           COALESCE(sum(g.cashback_amount), 0)::numeric AS cashback_total,
           COALESCE(sum(g.shop_share_amount), 0)::numeric AS shop_share_total,
           COALESCE(sum(g.expected_commission), 0)::numeric AS expected_commission
      FROM given_all g
     GROUP BY g.service_key, g.provider
  )
  SELECT COALESCE(a.service_key, g.service_key),
         COALESCE(a.provider, g.provider),
         COALESCE(a.orders, 0)::bigint,
         COALESCE(a.face_total, 0)::numeric,
         COALESCE(a.actual_commission, 0)::numeric,
         COALESCE(g.cashback_total, 0)::numeric,
         COALESCE(g.shop_share_total, 0)::numeric,
         COALESCE(g.expected_commission, 0)::numeric
    FROM actual a
    FULL OUTER JOIN given g ON g.service_key = a.service_key AND g.provider = a.provider;
$$;

REVOKE ALL ON FUNCTION cashback_margin_report(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cashback_margin_report(timestamptz, timestamptz) TO service_role;
