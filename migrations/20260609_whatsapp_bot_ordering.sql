-- WhatsApp Bot Ordering support
-- Adds channel column to ussd_orders to distinguish between USSD and WhatsApp orders
-- (mirrors existing airtime_orders and results_checker_orders tables).

ALTER TABLE public.ussd_orders
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'ussd';
