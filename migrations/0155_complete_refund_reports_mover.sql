-- 0155_complete_refund_reports_mover.sql
-- complete_order_refund answered 'completed' both to the caller that moved the row and to one that found it already
-- done, so a callback and the cron could each send the customer a refund SMS. A repeat now answers 'already_completed'.
-- Copied from 0120; only that return value changes. Nothing else reads it: lib/refunds/service.ts is the only caller.
--
-- ORDER: deploy the app first, then apply this. The new code accepts both answers. Old code reads 'already_completed' as
-- a ledger conflict, though only on a repeat that loses this race.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.complete_order_refund(p_refund_id uuid, p_gateway_ref text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_table text; v_order uuid; v_locked int; v_status text; v_col text;
BEGIN
  -- Returns: 'completed' (this call moved it), 'already_completed' (an earlier call did), or 'failed' if the row was
  -- already compensated (caller must treat that as a conflict: money has left).
  -- Lock order: advisory -> order row -> refund row (see 20261005).
  SELECT order_table, order_id INTO v_table, v_order FROM order_refunds WHERE id = p_refund_id;
  IF v_table IS NULL THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
  v_col := CASE WHEN v_table IN ('orders','api_orders','airtime_orders','hubtel_bill_orders','hubtel_data_orders')
                THEN 'status' ELSE 'order_status' END;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_order::text, 0));
  EXECUTE format('SELECT 1 FROM %I WHERE id = $1 FOR UPDATE', v_table) INTO v_locked USING v_order;
  SELECT status INTO v_status FROM order_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_status = 'completed' THEN RETURN 'already_completed'; END IF;
  IF v_status = 'failed' THEN RETURN 'failed'; END IF;
  UPDATE order_refunds SET status = 'completed', gateway_ref = COALESCE(p_gateway_ref, gateway_ref),
         error = NULL, completed_at = now(), updated_at = now() WHERE id = p_refund_id;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET %I = ''refunded'', updated_at = now() WHERE id = $1', v_table, v_col) USING v_order;
  IF v_table IN ('hubtel_bill_orders','hubtel_data_orders') THEN
    EXECUTE format('UPDATE %I SET payment_status = ''refunded'', updated_at = now() WHERE id = $1', v_table) USING v_order;
  END IF;
  PERFORM set_config('app.refund_rpc', 'off', true);
  RETURN 'completed';
END $$;

REVOKE ALL ON FUNCTION public.complete_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
