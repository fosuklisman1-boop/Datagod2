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

ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS price_reminders_sent smallint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS user_shops_price_reminder_scan_idx
  ON public.user_shops (price_reminders_sent, created_at)
  WHERE joined_via = 'storefront' AND prices_set_at IS NULL;
