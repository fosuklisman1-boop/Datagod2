-- 0188_ai_confirm_cards.sql
--
-- AI confirm cards, Task 1: the database foundation. ADDITIVE; service-role only. NOT applied by the implementing agent.
-- One transaction. Idempotent (IF NOT EXISTS / OR REPLACE; re-runnable). Nothing reads it yet.
--
--   ai_drafts: server-stored drafts the web AI chat prepares; the user taps Confirm (spec section 7.1). RLS on, no policies,
--       all client privileges revoked (service_role only). status adds 'partial'. CHECKs on status, action and context.
--   orders.idempotency_key uuid + UNIQUE partial index orders_idempotency_key_uniq (WHERE idempotency_key IS NOT NULL):
--       the second wall behind the draft claim.
--   ai_scheduled_tasks: standing_order jsonb, approved_draft_id uuid -> ai_drafts(id), consecutive_skips int not null default 0.
--       Client-writable by default (0060 + owner RLS), so a BEFORE INSERT OR UPDATE guard trigger raises STANDING_ORDER_SERVER_ONLY
--       (42501) when current_user is anon / authenticated and any of the three is set or changed. Undo: DROP TRIGGER
--       ai_scheduled_tasks_guard_standing_order ON public.ai_scheduled_tasks; DROP FUNCTION public.ai_scheduled_tasks_guard_standing_order();
--   revert_wallet_deduction(p_user_id uuid, p_amount numeric) RETURNS numeric (new balance): adds back exactly p_amount in one
--       UPDATE (safe after interleaved wallet writes); raises on p_amount <= 0 / NULL or no wallet row. SECURITY DEFINER,
--       search_path = public; EXECUTE revoked from PUBLIC / anon / authenticated, granted to service_role.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regclass('public.ai_drafts');                                                  -- NULL
--   SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='idempotency_key';  -- no rows
--   SELECT to_regclass('public.ai_scheduled_tasks'), to_regclass('public.orders'), to_regclass('public.wallets');  -- all NOT NULL
--   SELECT to_regprocedure('public.revert_wallet_deduction(uuid,numeric)');                  -- NULL
--   -- Apply in a quiet window: ALTER TABLE orders (ADD COLUMN, nullable, no default: metadata only) and CREATE UNIQUE INDEX
--   -- on orders take a short lock that queues order writes for up to the 5 s lock_timeout. A lock timeout just means retry.
--   -- The index is on an all-NULL column, so the build is quick; nothing is half-applied if it fails.
--
-- VERIFY after applying:
--   SELECT has_table_privilege('anon','public.ai_drafts','SELECT'), has_table_privilege('authenticated','public.ai_drafts','SELECT');  -- false, false
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_drafts'::regclass;            -- true
--   SELECT has_function_privilege('authenticated','public.revert_wallet_deduction(uuid,numeric)','EXECUTE');  -- false
--
-- Dry run: migrations/0188_ai_confirm_cards.selftest.sql (build the run string by code, as lib/ai-drafts/migration-0188.test.ts does).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ============ ai_drafts ============
CREATE TABLE IF NOT EXISTS public.ai_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  context          text NOT NULL CHECK (context IN ('dashboard', 'admin')),
  action           text NOT NULL CHECK (action IN ('wallet_order', 'wallet_adjustment', 'withdrawal_action', 'user_suspension', 'role_change', 'bulk_status_update')),
  params           jsonb NOT NULL,
  display          jsonb NOT NULL,
  amount_ghs       numeric(12,2),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'succeeded', 'partial', 'failed', 'unknown', 'expired', 'superseded', 'cancelled')),
  outcome          jsonb,
  expires_at       timestamptz NOT NULL,
  conversation_key text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  executed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS ai_drafts_user_status_created_idx ON public.ai_drafts (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_drafts_user_conversation_idx ON public.ai_drafts (user_id, conversation_key);

ALTER TABLE public.ai_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_drafts FROM anon, authenticated;
GRANT ALL ON public.ai_drafts TO service_role;

-- ============ orders.idempotency_key ============
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uniq ON public.orders (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============ ai_scheduled_tasks: standing orders ============
ALTER TABLE public.ai_scheduled_tasks ADD COLUMN IF NOT EXISTS standing_order jsonb;
ALTER TABLE public.ai_scheduled_tasks ADD COLUMN IF NOT EXISTS approved_draft_id uuid REFERENCES public.ai_drafts(id) ON DELETE SET NULL;
ALTER TABLE public.ai_scheduled_tasks ADD COLUMN IF NOT EXISTS consecutive_skips int NOT NULL DEFAULT 0;

-- ============ ai_scheduled_tasks: the three new columns are server-only ============
-- 0060 grants authenticated CRUD on every table and the 20260524 RLS policies let owners INSERT / UPDATE their own rows, so a
-- column-level REVOKE would be a no-op (the table-level grant still covers the column). A trigger refuses a client role
-- (current_user anon / authenticated) that sets or changes standing_order, approved_draft_id or consecutive_skips.
-- service_role and postgres (server routes, migrations, the SQL editor) pass. SECURITY INVOKER so current_user is the caller.
CREATE OR REPLACE FUNCTION public.ai_scheduled_tasks_guard_standing_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.standing_order IS NOT NULL OR NEW.approved_draft_id IS NOT NULL OR NEW.consecutive_skips <> 0 THEN
        RAISE EXCEPTION 'STANDING_ORDER_SERVER_ONLY: standing order columns are server-managed' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.standing_order IS DISTINCT FROM OLD.standing_order
       OR NEW.approved_draft_id IS DISTINCT FROM OLD.approved_draft_id
       OR NEW.consecutive_skips IS DISTINCT FROM OLD.consecutive_skips THEN
      RAISE EXCEPTION 'STANDING_ORDER_SERVER_ONLY: standing order columns are server-managed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ai_scheduled_tasks_guard_standing_order() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ai_scheduled_tasks_guard_standing_order ON public.ai_scheduled_tasks;
CREATE TRIGGER ai_scheduled_tasks_guard_standing_order
  BEFORE INSERT OR UPDATE ON public.ai_scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION public.ai_scheduled_tasks_guard_standing_order();

-- ============ revert_wallet_deduction ============
CREATE OR REPLACE FUNCTION public.revert_wallet_deduction(p_user_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_new numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be greater than 0';
  END IF;
  UPDATE public.wallets
     SET balance = balance + p_amount,
         total_spent = greatest(0, total_spent - p_amount),
         updated_at = now()
   WHERE user_id = p_user_id
  RETURNING balance INTO v_new;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found';
  END IF;
  RETURN v_new;
END;
$fn$;

REVOKE ALL ON FUNCTION public.revert_wallet_deduction(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revert_wallet_deduction(uuid, numeric) TO service_role;

COMMIT;
