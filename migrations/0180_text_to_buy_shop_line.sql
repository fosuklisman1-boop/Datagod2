-- 0180_text_to_buy_shop_line.sql
--
-- Text-to-Buy, Stage 3a: the SHOP line (a second number that sells for one USSD shop, its replies paid from that shop owner's
-- SMS credits). This file holds the new COLUMNS, TABLES and SQL FUNCTIONS. Nothing reads them until later tasks of the plan.
-- ADDITIVE; service-role only. NOT applied by the implementing agent. One transaction. Idempotent (re-runnable).
-- Needs 0177 (ttb_ tables), the SMS foundation (0061/0062/0065: sms_accounts, sms_unit_transactions, adjust_sms_units) and
-- ussd_shop_codes. Ships dark: it adds no setting and no code path that runs by itself.
--
--   ttb_orders.shop_id, ttb_messages.shop_id, ttb_messages.credits   nullable columns (NULL on every existing row / main line)
--   ttb_shop_prefs     the shop a sender last used on the shop line ("last bought from"); cascades with the shop code
--   ttb_notices        once-a-day throttle rows (kind, sender, shop, day) for the Datagod-paid shop-line notices
--   ttb_credit_reserves  one credit set-aside per order message: held, used, released_at. The money moves ONLY through
--                      adjust_sms_units (the single, race-safe way to change a unit balance); this table is the bookkeeping.
--
-- Credit rules (all through public.adjust_sms_units, never a direct balance update):
--   ttb_reserve_credits   one transaction: insert the reserve row (idempotent on message id), take the account row lock, check
--                         the account (missing/not active -> NOT_ACTIVATED, suspended -> SUSPENDED, as debit_sms_for_send),
--                         debit through adjust_sms_units (reason 'text_to_buy', ref 'ttb:<message>'; no row back ->
--                         INSUFFICIENT_CREDITS). Any raise rolls the reserve row back, so a failed debit leaves nothing.
--                         true = reserved now, false = this message was already reserved (nothing debited again).
--   ttb_draw_reserve      used = used + n only while the reserve is open and used + n <= held. Pure bookkeeping.
--   ttb_release_reserve   ONE transaction: mark released_at (only where NULL) AND refund held - used through adjust_sms_units
--                         (reason 'text_to_buy_refund', ref 'ttb:<message>:release'). A crash cannot split the two. Returns the
--                         credits refunded; 0 on a repeat, on an unknown message, or when everything was used. No status gate
--                         on a refund (money coming back is never blocked by a suspension).
--   ttb_debit_reply       single-reply debit, same status gate, reason 'text_to_buy', ledger ref = p_ref. true = debited,
--                         false = this ref was already debited. p_ref must be a non-empty text unique per reply.
--   ttb_refund_reply      gives back a debit made by ttb_debit_reply for the SAME account and p_ref, exactly once: the refund
--                         is ledgered under ref p_ref || ':refund' (the ledger enforces one row per ref), capped at what was
--                         debited. false when there was no such debit or it was already refunded (credits cannot be minted).
--   ttb_notice_once       true when THIS call created the (kind, sender, shop, day) row. A NULL shop is one slot, not many.
--   ttb_purge             replaced: still deletes old messages and expired conversations, now also notices older than the cut-off
--                         and RELEASED reserves created before it. An unreleased reserve is never purged: it still owes a refund.
--   ttb_heartbeat CHECK   gains 'quiet_alert_shop' (when the per-line quiet-line alert for the shop line last fired).
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.ttb_shop_prefs'), to_regclass('public.ttb_notices'), to_regclass('public.ttb_credit_reserves');   -- all NULL
--   SELECT to_regclass('public.ttb_orders'), to_regclass('public.ussd_shop_codes'), to_regclass('public.sms_accounts');           -- all NOT NULL
--   SELECT count(*) FROM pg_proc WHERE proname IN ('ttb_notice_once','ttb_reserve_credits','ttb_draw_reserve',
--          'ttb_release_reserve','ttb_debit_reply','ttb_refund_reply');                                                           -- 0
--   SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
--      AND ((table_name = 'ttb_orders' AND column_name = 'shop_id')
--        OR (table_name = 'ttb_messages' AND column_name IN ('shop_id', 'credits')));                                              -- 0
--   SELECT count(*) FROM pg_proc WHERE proname = 'adjust_sms_units';                                                              -- 1
--
-- Self-test (self-rolling-back dry run): migrations/0180_text_to_buy_shop_line.selftest.sql
-- The run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/text-to-buy/migration-0180.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. New columns on the Stage 1 tables.
ALTER TABLE public.ttb_orders   ADD COLUMN IF NOT EXISTS shop_id uuid;
ALTER TABLE public.ttb_messages ADD COLUMN IF NOT EXISTS shop_id uuid;
ALTER TABLE public.ttb_messages ADD COLUMN IF NOT EXISTS credits int;
CREATE INDEX IF NOT EXISTS ttb_orders_shop_created_idx   ON public.ttb_orders   (shop_id, created_at DESC) WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ttb_messages_shop_created_idx ON public.ttb_messages (shop_id, created_at DESC) WHERE shop_id IS NOT NULL;

-- 2. Heartbeat: allow the shop line's quiet-alert bookkeeping row. Replaces only the CHECK that lists the quiet_alert row.
DO $hb$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
     WHERE c.conrelid = 'public.ttb_heartbeat'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%quiet_alert%'
  LOOP
    EXECUTE format('ALTER TABLE public.ttb_heartbeat DROP CONSTRAINT %I', v_name);
  END LOOP;
  ALTER TABLE public.ttb_heartbeat ADD CONSTRAINT ttb_heartbeat_line_check
    CHECK (line IN ('main', 'shop', 'purge', 'quiet_alert', 'quiet_alert_shop'));
END $hb$;

-- 3. The shop a sender last used on the shop line.
CREATE TABLE IF NOT EXISTS public.ttb_shop_prefs (
  sender       text PRIMARY KEY,                                                  -- local 0XXXXXXXXX
  shop_code_id uuid NOT NULL REFERENCES public.ussd_shop_codes(id) ON DELETE CASCADE,
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Once-a-day notice throttle. A primary key cannot hold an expression, so the (kind, sender, coalesce(shop), day) key is a
--    unique index and the row has its own id; a NULL shop collapses to the all-zero uuid so it is ONE slot, not unlimited.
CREATE TABLE IF NOT EXISTS public.ttb_notices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  sender     text NOT NULL,
  shop_id    uuid,
  day        date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ttb_notices_once_idx
  ON public.ttb_notices (kind, sender, (COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid)), day);
CREATE INDEX IF NOT EXISTS ttb_notices_created_idx ON public.ttb_notices (created_at);

-- 5. Credit reserves. No foreign keys on purpose: message / account / shop rows may be purged or removed independently, and an
--    unreleased reserve must stay refundable. account_id is the SMS account that paid.
CREATE TABLE IF NOT EXISTS public.ttb_credit_reserves (
  message_id  uuid PRIMARY KEY,
  account_id  uuid NOT NULL,
  shop_id     uuid NOT NULL,
  held        int  NOT NULL CHECK (held > 0),
  used        int  NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= held),
  released_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ttb_credit_reserves_account_idx ON public.ttb_credit_reserves (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ttb_credit_reserves_created_idx ON public.ttb_credit_reserves (created_at);

-- 6. Lock the new tables down. No policies on purpose; 0060 grants authenticated CRUD by default, the REVOKE keeps it out.
ALTER TABLE public.ttb_shop_prefs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ttb_notices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ttb_credit_reserves  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ttb_shop_prefs      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ttb_notices         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ttb_credit_reserves FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.ttb_shop_prefs      TO service_role;
GRANT SELECT                 ON TABLE public.ttb_notices         TO service_role;   -- rows are created by ttb_notice_once, removed by ttb_purge
GRANT SELECT                 ON TABLE public.ttb_credit_reserves TO service_role;   -- rows change only through the ttb_*_reserve functions

-- 7. Functions (SECURITY DEFINER, search_path = public, pg_temp, EXECUTE for service_role only).
CREATE OR REPLACE FUNCTION public.ttb_notice_once(p_kind text, p_sender text, p_shop uuid, p_day date)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_hit boolean;
BEGIN
  INSERT INTO public.ttb_notices (kind, sender, shop_id, day)
  VALUES (p_kind, p_sender, p_shop, p_day)
  ON CONFLICT (kind, sender, (COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid)), day) DO NOTHING
  RETURNING true INTO v_hit;
  RETURN COALESCE(v_hit, false);
END
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_reserve_credits(p_account_id uuid, p_message_id uuid, p_shop_id uuid, p_credits int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status text;
  v_bal    int;
  v_ins    uuid;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 OR p_message_id IS NULL OR p_shop_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;
  IF p_account_id IS NULL THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;

  -- Idempotent on the message id. A concurrent twin blocks on the unique key until the first commits, then gets false.
  INSERT INTO public.ttb_credit_reserves (message_id, account_id, shop_id, held)
  VALUES (p_message_id, p_account_id, p_shop_id, p_credits)
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id INTO v_ins;
  IF v_ins IS NULL THEN RETURN false; END IF;

  -- Row lock (not FOR SHARE: two sharers upgrading to the debit's update lock would deadlock) so the status read and the
  -- debit see the same account.
  SELECT a.status INTO v_status FROM public.sms_accounts a WHERE a.id = p_account_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;
  IF v_status = 'suspended' THEN RAISE EXCEPTION 'SUSPENDED' USING ERRCODE = 'P0001'; END IF;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;

  SELECT t.balance_after INTO v_bal
    FROM public.adjust_sms_units(p_account_id, -p_credits, 'text_to_buy', 'ttb:' || p_message_id::text) t;
  IF v_bal IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_CREDITS' USING ERRCODE = 'P0001'; END IF;
  RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_draw_reserve(p_message_id uuid, p_credits int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_hit boolean;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RETURN false; END IF;
  UPDATE public.ttb_credit_reserves r
     SET used = r.used + p_credits
   WHERE r.message_id = p_message_id AND r.released_at IS NULL AND r.used + p_credits <= r.held
  RETURNING true INTO v_hit;
  RETURN COALESCE(v_hit, false);
END
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_release_reserve(p_message_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_account uuid;
  v_refund  int;
  v_bal     int;
BEGIN
  UPDATE public.ttb_credit_reserves r
     SET released_at = now()
   WHERE r.message_id = p_message_id AND r.released_at IS NULL
  RETURNING r.account_id, r.held - r.used INTO v_account, v_refund;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF v_refund > 0 THEN
    SELECT t.balance_after INTO v_bal
      FROM public.adjust_sms_units(v_account, v_refund, 'text_to_buy_refund', 'ttb:' || p_message_id::text || ':release') t;
    -- No row back = the account is gone. Raising undoes released_at above, so the release can be retried; never half-done.
    IF v_bal IS NULL THEN RAISE EXCEPTION 'REFUND_FAILED' USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN v_refund;
END
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_debit_reply(p_account_id uuid, p_credits int, p_ref text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status text;
  v_bal    int;
  v_reason text;
  v_acct   uuid;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001'; END IF;
  IF p_ref IS NULL OR length(p_ref) = 0 THEN RAISE EXCEPTION 'INVALID_REF' USING ERRCODE = 'P0001'; END IF;

  SELECT a.status INTO v_status FROM public.sms_accounts a WHERE a.id = p_account_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;

  -- This ref already in the ledger: ours = already debited (false); anyone else's = a bad ref, never a silent "paid".
  SELECT t.reason, t.sms_account_id INTO v_reason, v_acct FROM public.sms_unit_transactions t WHERE t.ref = p_ref;
  IF FOUND THEN
    IF v_reason = 'text_to_buy' AND v_acct = p_account_id THEN RETURN false; END IF;
    RAISE EXCEPTION 'INVALID_REF' USING ERRCODE = 'P0001';
  END IF;

  IF v_status = 'suspended' THEN RAISE EXCEPTION 'SUSPENDED' USING ERRCODE = 'P0001'; END IF;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'NOT_ACTIVATED' USING ERRCODE = 'P0001'; END IF;

  SELECT t.balance_after INTO v_bal FROM public.adjust_sms_units(p_account_id, -p_credits, 'text_to_buy', p_ref) t;
  IF v_bal IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_CREDITS' USING ERRCODE = 'P0001'; END IF;
  RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION public.ttb_refund_reply(p_account_id uuid, p_credits int, p_ref text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_locked uuid;
  v_debit  int;
  v_amount int;
  v_bal    int;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 OR p_ref IS NULL OR length(p_ref) = 0 THEN RETURN false; END IF;

  -- The account row lock serialises two refunds of one ref; the ledger's unique ref index is the final guard.
  SELECT a.id INTO v_locked FROM public.sms_accounts a WHERE a.id = p_account_id FOR UPDATE;
  IF v_locked IS NULL THEN RETURN false; END IF;

  SELECT -t.delta INTO v_debit FROM public.sms_unit_transactions t
   WHERE t.ref = p_ref AND t.sms_account_id = p_account_id AND t.reason = 'text_to_buy' AND t.delta < 0;
  IF v_debit IS NULL THEN RETURN false; END IF;                       -- nothing was debited under this ref: cannot mint credits

  IF EXISTS (SELECT 1 FROM public.sms_unit_transactions t WHERE t.ref = p_ref || ':refund') THEN RETURN false; END IF;

  v_amount := LEAST(p_credits, v_debit);
  SELECT t.balance_after INTO v_bal
    FROM public.adjust_sms_units(p_account_id, v_amount, 'text_to_buy_refund', p_ref || ':refund') t;
  IF v_bal IS NULL THEN RAISE EXCEPTION 'REFUND_FAILED' USING ERRCODE = 'P0001'; END IF;
  RETURN true;
END
$fn$;

-- Replaced (same signature as 0177): the old deletes plus old notices and released reserves.
CREATE OR REPLACE FUNCTION public.ttb_purge(p_before timestamptz)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_msgs int;
  v_convs int;
  v_notices int;
  v_reserves int;
BEGIN
  DELETE FROM public.ttb_messages m WHERE m.created_at < p_before;
  GET DIAGNOSTICS v_msgs = ROW_COUNT;
  DELETE FROM public.ttb_conversations c WHERE c.expires_at < p_before;
  GET DIAGNOSTICS v_convs = ROW_COUNT;
  DELETE FROM public.ttb_notices n WHERE n.created_at < p_before;
  GET DIAGNOSTICS v_notices = ROW_COUNT;
  -- Only RELEASED reserves: an unreleased one still owes the shop a refund of held - used.
  DELETE FROM public.ttb_credit_reserves r WHERE r.released_at IS NOT NULL AND r.created_at < p_before;
  GET DIAGNOSTICS v_reserves = ROW_COUNT;
  RETURN v_msgs + v_convs + v_notices + v_reserves;
END
$fn$;

-- 8. EXECUTE: service_role only. (CREATE OR REPLACE kept ttb_purge's 0177 grants; re-stated so a rerun is explicit.)
REVOKE ALL ON FUNCTION public.ttb_notice_once(text, text, uuid, date)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_reserve_credits(uuid, uuid, uuid, int)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_draw_reserve(uuid, int)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_release_reserve(uuid)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_debit_reply(uuid, int, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_refund_reply(uuid, int, text)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ttb_purge(timestamptz)                        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ttb_notice_once(text, text, uuid, date)    TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_reserve_credits(uuid, uuid, uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_draw_reserve(uuid, int)                TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_release_reserve(uuid)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_debit_reply(uuid, int, text)           TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_refund_reply(uuid, int, text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.ttb_purge(timestamptz)                     TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.oid IN ('public.ttb_shop_prefs'::regclass, 'public.ttb_notices'::regclass,
--     'public.ttb_credit_reserves'::regclass);                                                              -- 3 rows, all true
--   SELECT count(*) FROM pg_policies WHERE tablename IN ('ttb_shop_prefs', 'ttb_notices', 'ttb_credit_reserves');   -- 0
--   SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
--          has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname LIKE 'ttb\_%' ORDER BY 1;
--                                                                                                         -- 12 rows: false, false, true
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.ttb_heartbeat'::regclass AND contype = 'c';   -- lists quiet_alert_shop
