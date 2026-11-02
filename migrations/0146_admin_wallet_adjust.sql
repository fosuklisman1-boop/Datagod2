-- 0146_admin_wallet_adjust.sql
--
-- Atomic, audited admin wallet credit / debit for POST /api/admin/update-balance (the admin users page's
-- balance dialog and the admin AI tool). Replaces the route's read-then-write: it read the balance, wrote
-- balance = read + amount (a concurrent purchase between the two was lost), clamped a debit at 0 instead of
-- refusing it, and wrote the transactions row and the admin_audit_log row afterwards as best-effort calls
-- whose failures were only logged (the audit insert also always failed for the CRON bypass: admin_id is NOT NULL).
-- ADDITIVE. Idempotent (CREATE OR REPLACE). One transaction. No tables, columns or indexes are changed.
-- Must be applied BEFORE the code that calls it is deployed.
--
--   admin_wallet_adjust(p_admin_id uuid, p_user_id uuid, p_type text, p_amount numeric, p_reason text,
--                       p_expected_balance numeric DEFAULT NULL)
--     RETURNS jsonb {transaction_id, reference_id, type, amount, balance_before, balance_after}
--
--     In ONE transaction, with the user's wallet row locked FOR UPDATE:
--       1. wallets       balance +/- amount; total_credited (credit) or total_spent (debit) += amount;
--                        updated_at = now()   (same columns the route updated before)
--       2. transactions  type 'admin_credit' | 'admin_debit' (the types the route already wrote and the
--                        reconciliation scripts count), status 'completed', source 'admin_operation',
--                        reference_id 'ADMIN_<TYPE>_<32 hex>', balance_before / balance_after, and a
--                        description that carries the reason
--       3. admin_audit_log  action 'wallet_credit' | 'wallet_debit' (the actions the route already wrote),
--                        admin_id, target_user_id, old_value {balance}, new_value {balance, amount, type,
--                        reason, transaction_id, reference_id}
--     Any failure rolls all three back.
--
--     Errors (RAISE EXCEPTION <code>, DETAIL says why; nothing is written):
--       BAD_INPUT            admin or user id missing; type not credit/debit; amount NULL, <= 0, more than
--                            2 decimals or > 50000; reason shorter than 5 or longer than 500 characters
--                            after trimming
--       NOT_ADMIN            p_admin_id is not a users row with role 'admin'
--       WALLET_NOT_FOUND     the user has no wallet row
--       AMBIGUOUS_WALLET     the user has more than one wallet row (refused rather than guessing which)
--       BALANCE_CHANGED      p_expected_balance was given and the locked balance differs (the admin
--                            confirmed a before/after that is no longer true)
--       INSUFFICIENT_BALANCE a debit would leave the balance below 0
--
-- SECURITY DEFINER, search_path pinned to public, pg_temp, every table schema-qualified; EXECUTE for
-- service_role only. The route passes the admin's own id from verifyAdminAccess and refuses the CRON bypass.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_wallet_adjust(
  p_admin_id         uuid,
  p_user_id          uuid,
  p_type             text,
  p_amount           numeric,
  p_reason           text,
  p_expected_balance numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_rows    int;
  v_before  numeric;
  v_after   numeric;
  v_ref     text;
  v_tx_id   uuid;
BEGIN
  IF p_admin_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'admin and user are required';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('credit', 'debit') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'type must be credit or debit';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 50000 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'amount must be > 0, at most 50000, with at most 2 decimals';
  END IF;
  IF char_length(v_reason) < 5 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'reason must be 5 to 500 characters';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_admin_id AND u.role = 'admin') THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING DETAIL = 'acting user is not an admin';
  END IF;

  -- Lock every wallet row of the user (normally one) before reading the balance, so a concurrent
  -- purchase, refund or second adjustment waits for this transaction and then sees its result.
  PERFORM 1 FROM public.wallets w WHERE w.user_id = p_user_id FOR UPDATE;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND' USING DETAIL = 'user has no wallet';
  ELSIF v_rows > 1 THEN
    RAISE EXCEPTION 'AMBIGUOUS_WALLET' USING DETAIL = 'user has more than one wallet row';
  END IF;

  SELECT coalesce(w.balance, 0) INTO v_before FROM public.wallets w WHERE w.user_id = p_user_id;

  IF p_expected_balance IS NOT NULL AND p_expected_balance <> v_before THEN
    RAISE EXCEPTION 'BALANCE_CHANGED' USING DETAIL = format('balance is now %s', v_before);
  END IF;

  v_after := CASE WHEN p_type = 'credit' THEN v_before + p_amount ELSE v_before - p_amount END;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING DETAIL = format('balance %s is less than %s', v_before, p_amount);
  END IF;

  UPDATE public.wallets w
  SET balance        = v_after,
      total_credited = coalesce(w.total_credited, 0) + CASE WHEN p_type = 'credit' THEN p_amount ELSE 0 END,
      total_spent    = coalesce(w.total_spent, 0)    + CASE WHEN p_type = 'debit'  THEN p_amount ELSE 0 END,
      updated_at     = now()
  WHERE w.user_id = p_user_id;

  v_ref := 'ADMIN_' || upper(p_type) || '_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.transactions
    (user_id, amount, type, status, description, reference_id, source, balance_before, balance_after, created_at)
  VALUES
    (p_user_id, p_amount, 'admin_' || p_type, 'completed',
     CASE WHEN p_type = 'credit' THEN 'Admin credited GHS ' ELSE 'Admin debited GHS ' END
       || to_char(p_amount, 'FM999999990.00') || ': ' || v_reason,
     v_ref, 'admin_operation', v_before, v_after, now())
  RETURNING id INTO v_tx_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
  VALUES (
    p_admin_id,
    'wallet_' || p_type,
    p_user_id,
    jsonb_build_object('balance', v_before),
    jsonb_build_object('balance', v_after, 'amount', p_amount, 'type', p_type, 'reason', v_reason,
                       'transaction_id', v_tx_id, 'reference_id', v_ref)
  );

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'reference_id',   v_ref,
    'type',           p_type,
    'amount',         p_amount,
    'balance_before', v_before,
    'balance_after',  v_after
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_wallet_adjust(uuid, uuid, text, numeric, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_wallet_adjust(uuid, uuid, text, numeric, text, numeric) TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT has_function_privilege('authenticated', 'public.admin_wallet_adjust(uuid,uuid,text,numeric,text,numeric)', 'EXECUTE'); -- false
--   SELECT has_function_privilege('service_role',  'public.admin_wallet_adjust(uuid,uuid,text,numeric,text,numeric)', 'EXECUTE'); -- true
