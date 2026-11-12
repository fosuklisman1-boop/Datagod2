-- 0173_admin_user_orders_indexes.sql
-- Already applied to production on 2026-11-09 (as 0148_admin_user_orders_indexes.sql)
--
-- (user_id, created_at DESC) indexes for the per-table top-N branches of public.admin_user_orders
-- (0172_admin_user_orders.sql): each branch is
--   WHERE user_id = $1 [AND lower(status) = $2] ORDER BY created_at DESC, id DESC LIMIT offset + limit + 1
-- which these indexes answer by reading only the newest entries for that user, instead of fetching every
-- order the user has (the existing single-column user_id indexes) and sorting them.
-- hubtel_data_orders and hubtel_bill_orders already have (user_id, created_at DESC) indexes (0117, 0118).
--
-- ADDITIVE. Idempotent (IF NOT EXISTS). No data changes.
--
-- NO BEGIN/COMMIT: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run this file with
-- autocommit (psql -f, or the Supabase SQL editor one statement at a time); do NOT wrap it in a transaction
-- or a migration runner that adds one. CONCURRENTLY builds each index without blocking writes to the table.
-- If a build fails or is cancelled it leaves an INVALID index with the same name, which IF NOT EXISTS would
-- then skip: check with the query at the end, DROP INDEX CONCURRENTLY the invalid one, and run this again.
--
-- Apply after 0172 (which works without these indexes, just slower for users with many orders).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_user_created_at
  ON public.orders (user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_orders_user_created_at
  ON public.api_orders (user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_airtime_orders_user_created_at
  ON public.airtime_orders (user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_results_checker_orders_user_created_at
  ON public.results_checker_orders (user_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_afa_orders_user_created_at
  ON public.afa_orders (user_id, created_at DESC);

-- Verify after apply (expect 5 rows, all valid):
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--   WHERE c.relname LIKE 'idx\_%\_user\_created\_at';
