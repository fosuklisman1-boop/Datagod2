-- ─────────────────────────────────────────────────────────────────
-- 1. assign_results_checker_vouchers
--    Atomically reserves N available vouchers for a given order.
--    Uses FOR UPDATE SKIP LOCKED to prevent double-allocation under
--    concurrent requests.  Returns the reserved rows' id/pin/serial.
-- ─────────────────────────────────────────────────────────────────
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
BEGIN
  SELECT COALESCE((value->>'minutes')::INTEGER, 10)
    INTO v_timeout_minutes
    FROM admin_settings
   WHERE key = 'results_checker_reservation_timeout';

  RETURN QUERY
  WITH selected AS (
    SELECT rci.id
      FROM results_checker_inventory rci
     WHERE rci.exam_board = p_exam_board
       AND rci.status = 'available'
       AND (rci.expiry_date IS NULL OR rci.expiry_date > CURRENT_DATE)
     ORDER BY rci.created_at ASC   -- FIFO: oldest upload sold first
     LIMIT p_quantity
     FOR UPDATE SKIP LOCKED        -- skip rows locked by concurrent transactions
  )
  UPDATE results_checker_inventory rci
     SET status                 = 'reserved',
         reserved_by_order      = p_order_id,
         reservation_expires_at = now() + (v_timeout_minutes || ' minutes')::INTERVAL,
         updated_at             = now()
    FROM selected
   WHERE rci.id = selected.id
   RETURNING rci.id, rci.pin, rci.serial_number;
END;
$$;


-- ─────────────────────────────────────────────────────────────────
-- 2. finalize_results_checker_sale
--    Marks reserved vouchers as sold after payment is confirmed.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finalize_results_checker_sale(
  p_order_id UUID,
  p_user_id  UUID  -- NULL for guest orders
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE results_checker_inventory
     SET status          = 'sold',
         sold_to_user_id = p_user_id,
         sold_at         = now(),
         updated_at      = now()
   WHERE reserved_by_order = p_order_id
     AND status = 'reserved';
END;
$$;


-- ─────────────────────────────────────────────────────────────────
-- 3. release_expired_results_checker_reservations
--    Releases vouchers whose reservation window has elapsed.
--    Call this on a cron every 5 minutes.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION release_expired_results_checker_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE results_checker_inventory
     SET status                 = 'available',
         reserved_by_order      = NULL,
         reservation_expires_at = NULL,
         updated_at             = now()
   WHERE status = 'reserved'
     AND reservation_expires_at < now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
