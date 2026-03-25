-- 1. Add columns to airtime_orders for tiered commissions
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS parent_dealer_id UUID REFERENCES public.users(id);
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS dealer_commission NUMERIC(10,2) DEFAULT 0;

-- 2. Index for parent lookups
CREATE INDEX IF NOT EXISTS idx_airtime_orders_parent ON public.airtime_orders(parent_dealer_id);

-- 3. Seed sub-agent fee settings (defaulting to midway between dealer and customer)
INSERT INTO admin_settings (key, value) VALUES
  ('airtime_fee_mtn_sub_agent',     '{"rate": 4}'),
  ('airtime_fee_telecel_sub_agent', '{"rate": 4}'),
  ('airtime_fee_at_sub_agent',      '{"rate": 4}')
ON CONFLICT (key) DO NOTHING;
