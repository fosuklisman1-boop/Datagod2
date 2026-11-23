-- 0196_ai_drafts_admin_route_call.sql
--
-- AI admin full access, Task 1: widen the ai_drafts.action CHECK so confirm-card drafts can store 'admin_route_call'.
-- NOT applied by the implementing agent. One transaction. Idempotent (DROP CONSTRAINT IF EXISTS + ADD; re-runnable).
--
--   The 0188 CHECK is an inline column constraint, auto-named ai_drafts_action_check. It is dropped and re-added with the six
--   existing actions plus admin_route_call. Existing rows all satisfy the wider list, so the ADD validates cleanly. No other
--   change: grants, RLS and every other column are untouched.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.ai_drafts');                                                  -- NOT NULL
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.ai_drafts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%wallet_order%';  -- ai_drafts_action_check
--
-- VERIFY after applying:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ai_drafts_action_check' AND conrelid = 'public.ai_drafts'::regclass;  -- lists admin_route_call
--
-- Undo (only while no admin_route_call rows exist): re-run the two ALTERs below with the six original names.
-- Dry run: migrations/0196_ai_drafts_admin_route_call.selftest.sql (build the run string by code, lib/ai-admin-catalog/migration-0196-run.ts).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.ai_drafts DROP CONSTRAINT IF EXISTS ai_drafts_action_check;
ALTER TABLE public.ai_drafts ADD CONSTRAINT ai_drafts_action_check
  CHECK (action IN ('wallet_order', 'wallet_adjustment', 'withdrawal_action', 'user_suspension', 'role_change', 'bulk_status_update', 'admin_route_call'));

COMMIT;
