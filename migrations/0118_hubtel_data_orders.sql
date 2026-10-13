-- 0118_hubtel_data_orders.sql
-- Standard Bundles (wallet-paid Hubtel data) via Hubtel Commission Services (Phase 2b). ADDITIVE; service-role only.

CREATE TABLE IF NOT EXISTS hubtel_data_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code          text NOT NULL UNIQUE,
  user_id                 uuid NOT NULL,
  channel                 text NOT NULL DEFAULT 'dashboard' CHECK (channel IN ('dashboard')),
  network                 text NOT NULL CHECK (network IN ('MTN','TELECEL','AT')),
  service_key             text NOT NULL,
  beneficiary_phone       text NOT NULL,
  bundle_value            text NOT NULL,
  bundle_display          text NOT NULL,
  bundle_category         text NOT NULL,
  amount                  numeric(12,2) NOT NULL CHECK (amount > 0),
  status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','processing','completed','failed','refunded')),
  payment_status          text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  idempotency_key         text NOT NULL,
  hubtel_client_reference text UNIQUE,
  commission              numeric(12,6),
  failure_reason          text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS hubtel_data_orders_user_idx   ON hubtel_data_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hubtel_data_orders_status_idx ON hubtel_data_orders (status, created_at);

ALTER TABLE hubtel_data_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_data_orders FROM anon, authenticated;

-- Atomic merge into admin_settings['standard_bundles_config']; top-level keys replace, "networks" merges per network key.
CREATE OR REPLACE FUNCTION standard_bundles_config_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  INSERT INTO admin_settings (key, value, description, updated_at)
  VALUES ('standard_bundles_config', '{}'::jsonb, 'Standard Bundles (Hubtel data): master switch, per-network switches, hidden categories, catalog reference numbers.', now())
  ON CONFLICT (key) DO NOTHING;

  UPDATE admin_settings
     SET value = (COALESCE(value, '{}'::jsonb) || (p_patch - 'networks'))
                 || CASE WHEN jsonb_typeof(p_patch -> 'networks') = 'object'
                         THEN jsonb_build_object('networks', COALESCE(value -> 'networks', '{}'::jsonb) || (p_patch -> 'networks'))
                         ELSE '{}'::jsonb END,
         updated_at = now()
   WHERE key = 'standard_bundles_config'
  RETURNING value INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION standard_bundles_config_patch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION standard_bundles_config_patch(jsonb) TO service_role;

-- Atomic wallet debit for a data order: lock the order, deduct, mark paid and write the wallet history row in ONE transaction.
CREATE OR REPLACE FUNCTION data_order_debit(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE o hubtel_data_orders%ROWTYPE; d record;
BEGIN
  SELECT * INTO o FROM hubtel_data_orders
   WHERE id = p_order_id AND status = 'pending' AND payment_status = 'unpaid' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  SELECT * INTO d FROM deduct_wallet(o.user_id, o.amount);
  IF NOT FOUND THEN RETURN 'insufficient'; END IF;

  UPDATE hubtel_data_orders SET payment_status = 'paid', updated_at = now() WHERE id = o.id;

  INSERT INTO transactions (user_id, type, source, amount, balance_before, balance_after, description, reference_id, status, created_at)
  VALUES (o.user_id, 'debit', 'standard_bundle', o.amount, d.old_balance, d.new_balance,
          'Standard bundle: ' || o.network || ' ' || o.bundle_display || ' to ' || o.beneficiary_phone, o.reference_code, 'completed', now());
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION data_order_debit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION data_order_debit(uuid) TO service_role;
