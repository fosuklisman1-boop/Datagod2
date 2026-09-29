-- 20260929_shop_afa_support.sql
--
-- Real shop-scoped AFA registration support. afa_orders.user_id is NOT NULL
-- and tightly coupled to the authenticated wallet-debit flow
-- (submitAfaOrder / deduct_wallet RPC) -- it was never designed for guest
-- storefront checkout, unlike shop_orders/airtime_orders/
-- results_checker_orders. ussd_afa_orders already solves exactly this
-- problem for the USSD channel (no user_id, Paystack-paid via
-- payment_status/paystack_reference, same real provider-dispatch
-- fulfillment engine in lib/ussd/fulfill-afa.ts) -- reusing it here rather
-- than relaxing a NOT NULL constraint on the live wallet-based table.
ALTER TABLE public.ussd_afa_orders
  ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES public.user_shops(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merchant_commission NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ussd_afa_orders_shop_id ON public.ussd_afa_orders(shop_id);

-- NULL = AFA registration is off for this shop's storefront (the reference's
-- "clearing the field turns it off" behavior). A real price enables it.
ALTER TABLE public.user_shops
  ADD COLUMN IF NOT EXISTS afa_price NUMERIC(10,2);
