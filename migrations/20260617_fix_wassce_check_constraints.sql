-- Fix: WASSCE results-checker vouchers were structurally blocked.
--
-- The WAEC→WASSCE rename (20260609_rename_waec_to_wassce.sql) updated row DATA and
-- admin_settings keys, but NEVER altered the exam_board CHECK constraints. Those still
-- only allowed the OLD 'WAEC' literal:
--     CHECK (exam_board = ANY (ARRAY['WAEC','BECE','NOVDEC']))
-- while the code now sends 'WASSCE'. Effects in production:
--   • results_checker_inventory: admins cannot ADD WASSCE voucher stock (insert rejected).
--   • results_checker_orders: WASSCE voucher orders fail at insert → "Error creating order".
-- (BECE/NOVDEC were unaffected.) The rename migration itself would also error if any WAEC
-- rows remained, because its `UPDATE ... SET exam_board='WASSCE'` violates the old check.
--
-- This migration drops the stale checks, migrates any leftover WAEC rows, and re-adds the
-- checks allowing WASSCE. Idempotent — safe to re-run.

-- ── results_checker_inventory ────────────────────────────────────────────────
ALTER TABLE results_checker_inventory
  DROP CONSTRAINT IF EXISTS results_checker_inventory_exam_board_check;

UPDATE results_checker_inventory
  SET exam_board = 'WASSCE'
  WHERE exam_board = 'WAEC';

ALTER TABLE results_checker_inventory
  ADD CONSTRAINT results_checker_inventory_exam_board_check
  CHECK (exam_board = ANY (ARRAY['WASSCE'::text, 'BECE'::text, 'NOVDEC'::text]));

-- ── results_checker_orders ───────────────────────────────────────────────────
ALTER TABLE results_checker_orders
  DROP CONSTRAINT IF EXISTS results_checker_orders_exam_board_check;

UPDATE results_checker_orders
  SET exam_board = 'WASSCE'
  WHERE exam_board = 'WAEC';

ALTER TABLE results_checker_orders
  ADD CONSTRAINT results_checker_orders_exam_board_check
  CHECK (exam_board = ANY (ARRAY['WASSCE'::text, 'BECE'::text, 'NOVDEC'::text]));
