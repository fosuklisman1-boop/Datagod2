-- Strict per-supplier MTN verification: schema only. NOT applied by the implementing agent. One transaction. Idempotent.
--
--   1. mtn_supplier_verdicts: one row per (phone, supplier) holding that supplier's own yes/no answer. phone is stored as 0XXXXXXXXX.
--      A re-check overwrites the row (upsert on the primary key), so checked_at is the time of the latest answer.
--   2. mtn_strict_holds: one row per held order (order_table + order_id). A hold is 'open' until it is 'released' (a supplier said
--      yes and the order was sent) or 'expired'. reason is why it was held: 'rejected' (every supplier said no) or 'unanswered'
--      (no supplier gave an answer). sms_sent records that the customer was told, so the SMS is sent once.
--   Both tables are service-role only: RLS on with no policies, everything revoked from PUBLIC/anon/authenticated.
--   service_role gets SELECT/INSERT/UPDATE (plus DELETE on verdicts, so stale verdicts can be pruned).
--
-- PRE-CHECK (read-only; must return no rows, or 0194 was already partly applied by hand with a different shape):
--   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('mtn_supplier_verdicts', 'mtn_strict_holds');
--
-- VERIFY after applying (read-only):
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('mtn_supplier_verdicts', 'mtn_strict_holds');                  -- both true
--   SELECT indexname FROM pg_indexes WHERE tablename = 'mtn_strict_holds';           -- pkey, mtn_strict_holds_state_checked, mtn_strict_holds_open_phone
--   SELECT has_table_privilege('anon', 'public.mtn_supplier_verdicts', 'SELECT'), has_table_privilege('authenticated', 'public.mtn_strict_holds', 'SELECT'),
--          has_table_privilege('service_role', 'public.mtn_strict_holds', 'UPDATE');                                              -- false, false, true

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS mtn_supplier_verdicts (
  phone      text        NOT NULL,
  supplier   text        NOT NULL,
  verdict    text        NOT NULL CHECK (verdict IN ('yes', 'no')),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone, supplier)
);

CREATE TABLE IF NOT EXISTS mtn_strict_holds (
  order_table     text        NOT NULL CHECK (order_table IN ('orders', 'shop_orders', 'api_orders', 'ussd_orders', 'ussd_shop_orders')),
  order_id        text        NOT NULL,
  phone           text        NOT NULL,
  reason          text        NOT NULL CHECK (reason IN ('rejected', 'unanswered')),
  state           text        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'released', 'expired')),
  held_at         timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  sms_sent        boolean     NOT NULL DEFAULT false,
  closed_at       timestamptz,
  PRIMARY KEY (order_table, order_id)
);

CREATE INDEX IF NOT EXISTS mtn_strict_holds_state_checked ON mtn_strict_holds (state, last_checked_at);
CREATE INDEX IF NOT EXISTS mtn_strict_holds_open_phone ON mtn_strict_holds (phone) WHERE state = 'open';

ALTER TABLE mtn_supplier_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mtn_strict_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mtn_supplier_verdicts, mtn_strict_holds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mtn_supplier_verdicts TO service_role;
GRANT SELECT, INSERT, UPDATE ON mtn_strict_holds TO service_role;

COMMIT;
