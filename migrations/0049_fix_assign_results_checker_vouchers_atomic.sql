-- Fix assign_results_checker_vouchers to be all-or-nothing.
--
-- Problem: under concurrent load, FOR UPDATE SKIP LOCKED could cause
-- partial reservation (e.g. 1 of 2 requested vouchers locked while the
-- other was held by a competing transaction). The partial reservation was
-- left in 'reserved' state for the failed order, blocking those vouchers
-- until the expiry cron ran (up to 10 min).
--
-- Fix: after the UPDATE, count what was actually reserved for this order.
-- If fewer than p_quantity, immediately release them back to 'available'
-- and return an empty set so the caller marks the order as failed.

CREATE OR REPLACE FUNCTION assign_results_checker_vouchers(
  p_exam_board TEXT,
  p_quantity   INTEGER,
  p_order_id   UUID
)
RETURNS TABLE(id UUID, pin TEXT, serial_number TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_timeout_minutes INTEGER;
  v_reserved_ids    UUID[];
BEGIN
  SELECT COALESCE((value->>'minutes')::INTEGER, 10)
    INTO v_timeout_minutes
    FROM admin_settings
   WHERE key = 'results_checker_reservation_timeout';

  -- Atomically reserve up to p_quantity available vouchers (FIFO order)
  WITH selected AS (
    SELECT rci.id
      FROM results_checker_inventory rci
     WHERE rci.exam_board = p_exam_board
       AND rci.status     = 'available'
       AND (rci.expiry_date IS NULL OR rci.expiry_date > CURRENT_DATE)
     ORDER BY rci.created_at ASC
     LIMIT p_quantity
     FOR UPDATE SKIP LOCKED
  )
  UPDATE results_checker_inventory rci
     SET status                 = 'reserved',
         reserved_by_order      = p_order_id,
         reservation_expires_at = now() + (v_timeout_minutes || ' minutes')::INTERVAL,
         updated_at             = now()
    FROM selected
   WHERE rci.id = selected.id;

  -- Collect IDs that were actually reserved for this order
  SELECT ARRAY_AGG(id) INTO v_reserved_ids
    FROM results_checker_inventory
   WHERE reserved_by_order = p_order_id
     AND status             = 'reserved';

  -- All-or-nothing: if we got fewer than requested, release immediately
  IF array_length(v_reserved_ids, 1) IS NULL
     OR array_length(v_reserved_ids, 1) < p_quantity
  THEN
    UPDATE results_checker_inventory
       SET status                 = 'available',
           reserved_by_order      = NULL,
           reservation_expires_at = NULL,
           updated_at             = now()
     WHERE id = ANY(v_reserved_ids);
    RETURN; -- empty result — caller marks order as failed
  END IF;

  -- Full quantity reserved — return to caller
  RETURN QUERY
    SELECT rci.id, rci.pin, rci.serial_number
      FROM results_checker_inventory rci
     WHERE rci.id = ANY(v_reserved_ids);
END;
$$;
