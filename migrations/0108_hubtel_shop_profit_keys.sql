-- 0108_hubtel_shop_profit_keys.sql
-- STATUS: WRITTEN, NOT APPLIED. Apply to production BEFORE deploying feat/hubtel-ussd (after 0106
-- and 0107), and only after the pre-checks below come back empty.
--
-- Part 1: hubtel_transactions.review_reason
--   A short, sanitised reason written when a paid Hubtel row lands in needs_review (handler error,
--   underpayment, missing handler, late success, stale-processing sweep, indeterminate expiry).
--   callback_last_error is wiped by a later successful callback and resolution_note is overwritten
--   at resolve, so neither can carry it. Code deployed BEFORE this column exists still parks the
--   row in needs_review: the reason is written by a separate best-effort update that fails (and is
--   logged) without affecting the state change.
--
-- Part 2: shop_profits once-per-(order, shop) keys
--   Partial unique indexes so a second credit for the same order and shop fails with 23505 (which
--   the Hubtel shop-order handler treats as "already credited"). Refund clawback / undo rows never
--   set these order FK columns (they set refund_id only; see migrations/20261005_order_refunds.sql
--   and migrations/20261007_refunds_bulk_api_orders.sql, "INSERT INTO shop_profits (shop_id,
--   profit_amount, status, refund_id, notes, ...)"), so clawbacks are unaffected. The results-checker
--   library's un-linked fallback row (no results_checker_order_id) is also unaffected.
--
-- HOW TO APPLY
--   1. Run the PRE-CHECK queries below. Each must return ZERO rows. Historical duplicates must be
--      resolved by a human (decide which row is the real credit, reverse/delete the other with an
--      audit note) BEFORE the index is created; this migration never deletes data.
--   2. Run Part 1 (instant: adds a nullable column).
--   3. Run each CREATE UNIQUE INDEX CONCURRENTLY statement ON ITS OWN. CONCURRENTLY cannot run inside
--      a transaction block, and many SQL runners (the Supabase SQL editor, the Management API, psql -1)
--      wrap a multi-statement script in one implicit transaction, which makes it fail. If a concurrent
--      build fails it leaves an INVALID index: DROP INDEX CONCURRENTLY it, fix the cause, retry.
--      Alternative if CONCURRENTLY is not possible: drop the CONCURRENTLY keyword and run each
--      statement after `SET lock_timeout = '5s';` (it then takes a short write lock on shop_profits;
--      retry on a lock timeout rather than raising the timeout).

-- ───────────────────── PRE-CHECKS (run first; each must return no rows) ─────────────────────
-- SELECT ussd_shop_order_id, shop_id, count(*), array_agg(id ORDER BY created_at), sum(profit_amount)
--   FROM shop_profits WHERE ussd_shop_order_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
--
-- SELECT results_checker_order_id, shop_id, count(*), array_agg(id ORDER BY created_at), sum(profit_amount)
--   FROM shop_profits WHERE results_checker_order_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
--
-- SELECT airtime_order_id, shop_id, count(*), array_agg(id ORDER BY created_at), sum(profit_amount)
--   FROM shop_profits WHERE airtime_order_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;

-- ───────────────────── Part 1 ─────────────────────
ALTER TABLE hubtel_transactions ADD COLUMN IF NOT EXISTS review_reason text;

-- ───────────────────── Part 2 (one statement at a time, outside a transaction) ─────────────────────
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_shop_profits_ussd_shop_order_shop
  ON shop_profits (ussd_shop_order_id, shop_id) WHERE ussd_shop_order_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_shop_profits_results_checker_order_shop
  ON shop_profits (results_checker_order_id, shop_id) WHERE results_checker_order_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_shop_profits_airtime_order_shop
  ON shop_profits (airtime_order_id, shop_id) WHERE airtime_order_id IS NOT NULL;
