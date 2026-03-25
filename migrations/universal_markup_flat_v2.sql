-- 1. Add airtime markup columns to user_shops (Profit margins set by the merchant)
ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS airtime_markup_mtn NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS airtime_markup_telecel NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.user_shops ADD COLUMN IF NOT EXISTS airtime_markup_at NUMERIC(10,2) DEFAULT 0;

-- 2. Add commission and shop tracking to airtime_orders
-- shop_id: tracks which shop's link was used
-- merchant_commission: the profit (markup) earned by the shop owner
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES public.user_shops(id);
ALTER TABLE public.airtime_orders ADD COLUMN IF NOT EXISTS merchant_commission NUMERIC(10,2) DEFAULT 0;

-- 3. Index for performance
CREATE INDEX IF NOT EXISTS idx_airtime_orders_shop ON public.airtime_orders(shop_id);

-- 4. Initial seed (ensure all shops have 0 markup by default)
UPDATE public.user_shops SET airtime_markup_mtn = 0, airtime_markup_telecel = 0, airtime_markup_at = 0 WHERE airtime_markup_mtn IS NULL;
