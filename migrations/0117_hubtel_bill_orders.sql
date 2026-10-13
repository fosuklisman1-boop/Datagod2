-- 0117_hubtel_bill_orders.sql
-- Utility bill payments via Hubtel Commission Services (Phase 3a). ADDITIVE; service-role only.

CREATE TABLE IF NOT EXISTS hubtel_bill_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code          text NOT NULL UNIQUE,
  user_id                 uuid NOT NULL,
  channel                 text NOT NULL DEFAULT 'dashboard' CHECK (channel IN ('dashboard')),
  biller                  text NOT NULL CHECK (biller IN ('ecg','ghana_water','dstv','gotv','startimes','telecel_broadband')),
  account_number          text NOT NULL,
  phone                   text,
  email                   text,
  broadband_account       text,
  session_id              text,
  customer_name           text,
  verified                boolean NOT NULL DEFAULT true,
  amount                  numeric(12,2) NOT NULL CHECK (amount > 0),
  status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','processing','completed','failed','refunded')),
  payment_status          text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  verify_token_hash       text UNIQUE,
  hubtel_client_reference text UNIQUE,
  commission              numeric(12,6),
  failure_reason          text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hubtel_bill_orders_user_idx   ON hubtel_bill_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hubtel_bill_orders_status_idx ON hubtel_bill_orders (status, created_at);
CREATE INDEX IF NOT EXISTS hubtel_bill_orders_biller_idx ON hubtel_bill_orders (biller, created_at);

ALTER TABLE hubtel_bill_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_bill_orders FROM anon, authenticated;

-- Atomic merge into admin_settings['utility_bills_config']; top-level keys replace, "billers" merges per biller key.
CREATE OR REPLACE FUNCTION utility_bills_config_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  INSERT INTO admin_settings (key, value, description, updated_at)
  VALUES ('utility_bills_config', '{}'::jsonb, 'Utility bills (Hubtel): master switch, auto-fulfil, per-biller switches and limits.', now())
  ON CONFLICT (key) DO NOTHING;

  UPDATE admin_settings
     SET value = (COALESCE(value, '{}'::jsonb) || (p_patch - 'billers'))
                 || CASE WHEN jsonb_typeof(p_patch -> 'billers') = 'object'
                         THEN jsonb_build_object('billers', COALESCE(value -> 'billers', '{}'::jsonb) || (p_patch -> 'billers'))
                         ELSE '{}'::jsonb END,
         updated_at = now()
   WHERE key = 'utility_bills_config'
  RETURNING value INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION utility_bills_config_patch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION utility_bills_config_patch(jsonb) TO service_role;

-- Atomic wallet debit for a bill order: lock the order, deduct, mark paid and write the wallet history row in ONE transaction.
CREATE OR REPLACE FUNCTION bill_order_debit(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE o hubtel_bill_orders%ROWTYPE; d record;
BEGIN
  SELECT * INTO o FROM hubtel_bill_orders
   WHERE id = p_order_id AND status = 'pending' AND payment_status = 'unpaid' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  SELECT * INTO d FROM deduct_wallet(o.user_id, o.amount);
  IF NOT FOUND THEN RETURN 'insufficient'; END IF;

  UPDATE hubtel_bill_orders SET payment_status = 'paid', updated_at = now() WHERE id = o.id;

  INSERT INTO transactions (user_id, type, source, amount, balance_before, balance_after, description, reference_id, status, created_at)
  VALUES (o.user_id, 'debit', 'utility_bill', o.amount, d.old_balance, d.new_balance,
          'Utility bill: ' || o.biller || ' ' || o.account_number, o.reference_code, 'completed', now());
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION bill_order_debit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bill_order_debit(uuid) TO service_role;
