-- 0165_admin_user_signals_indexes.sql
-- Already applied to production on 2026-11-09 (as 0150_admin_user_signals_indexes.sql)
--
-- (user_id, created_at DESC) index on public.transactions for the "refunds in the last 7 days" count of
-- public.admin_user_signals (0164_admin_user_notes_tags.sql):
--   WHERE user_id = $1 AND created_at >= now() - 7 days AND (refund) LIMIT 50
-- With only idx_transactions_user_id (0032) that reads every transaction the user ever had (a busy dealer has
-- tens of thousands); with this index it reads only the last 7 days of them.
-- The order-table counts use the (user_id, created_at DESC) indexes from 0163 and 0117/0118; admin_audit_log
-- already has idx_admin_audit_log_target (target_user_id, created_at DESC).
--
-- ADDITIVE. Idempotent (IF NOT EXISTS). No data changes.
--
-- NO BEGIN/COMMIT: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run this file with
-- autocommit (psql -f, or the Supabase SQL editor on its own); do NOT wrap it in a transaction. CONCURRENTLY
-- builds the index without blocking writes to transactions. If the build fails or is cancelled it leaves an
-- INVALID index with the same name, which IF NOT EXISTS would then skip: check with the query at the end,
-- DROP INDEX CONCURRENTLY the invalid one, and run this again.
--
-- Apply after 0164 (which works without this index, just slower for users with many transactions).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_user_created_at
  ON public.transactions (user_id, created_at DESC);

-- Verify after apply (expect one row, valid = true):
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--   WHERE c.relname = 'idx_transactions_user_created_at';
