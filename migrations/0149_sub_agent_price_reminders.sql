-- 0149_sub_agent_price_reminders.sql
--
-- "Set your prices and go live" reminders for storefront joiners (lib/sub-agents/price-reminders.ts, cron
-- /api/cron/sub-agent-price-reminders every 5 minutes). ADDITIVE. Idempotent (re-runnable).
--
--   user_shops.price_reminders_sent   last reminder stage handled (0 none, 1 = 10 min, 2 = 48 h, 3 = 72 h).
--       "Handled" = sent, or skipped because the joiner could not price at that time. The job claims a stage with
--       UPDATE ... WHERE price_reminders_sent = <old>, so overlapping runs send at most once. Default 0: existing
--       unpriced joiners become candidates and get the stage that is due for their age (one message at most).
--   index user_shops_price_reminder_scan_idx   partial, only closed storefront joiners: the job's scan.
--   check user_shops_price_reminders_sent_range   0..3 (dropped and re-added, so re-runnable).
--   function user_shops_protect_join_columns()   REPLACED: the 0148 body exactly, plus price_reminders_sent and
--       created_at (the join time the reminders are timed from). A signed-in owner who could update their row
--       could otherwise reset the counter and trigger a paid SMS every run. Production grants authenticated only
--       SELECT on user_shops today; this is the second layer. The 0148 trigger already points at this function.

ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS price_reminders_sent smallint NOT NULL DEFAULT 0;

ALTER TABLE public.user_shops DROP CONSTRAINT IF EXISTS user_shops_price_reminders_sent_range;
ALTER TABLE public.user_shops
  ADD CONSTRAINT user_shops_price_reminders_sent_range CHECK (price_reminders_sent BETWEEN 0 AND 3);

CREATE INDEX IF NOT EXISTS user_shops_price_reminder_scan_idx
  ON public.user_shops (price_reminders_sent, created_at)
  WHERE joined_via = 'storefront' AND prices_set_at IS NULL;

CREATE OR REPLACE FUNCTION public.user_shops_protect_join_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF auth.role() IN ('authenticated', 'anon') AND (
       NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.joined_via IS DISTINCT FROM OLD.joined_via
    OR NEW.prices_set_at IS DISTINCT FROM OLD.prices_set_at
    OR NEW.dealer_rates_enabled IS DISTINCT FROM OLD.dealer_rates_enabled
    OR NEW.sub_agent_setup_alert_at IS DISTINCT FROM OLD.sub_agent_setup_alert_at
    OR NEW.sub_agent_prices_ready_notified_at IS DISTINCT FROM OLD.sub_agent_prices_ready_notified_at
    OR NEW.is_blocked IS DISTINCT FROM OLD.is_blocked
    OR NEW.block_reason IS DISTINCT FROM OLD.block_reason
    OR NEW.parent_shop_id IS DISTINCT FROM OLD.parent_shop_id
    OR NEW.tier_level IS DISTINCT FROM OLD.tier_level
    OR NEW.price_reminders_sent IS DISTINCT FROM OLD.price_reminders_sent
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'protected shop columns cannot be changed by the shop owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

-- Verify after apply:
--   SELECT count(*) FROM public.user_shops WHERE price_reminders_sent <> 0;   -- 0 right after apply
--   SELECT pg_get_functiondef('public.user_shops_protect_join_columns()'::regprocedure) LIKE '%price_reminders_sent%';  -- true
--   SELECT tgenabled FROM pg_trigger WHERE tgname = 'user_shops_protect_join_columns';  -- 'O'
