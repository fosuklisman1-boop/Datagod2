-- 20260929_shop_order_confirmation_sms_toggle.sql
--
-- Adds a real per-shop toggle for the customer-facing order-confirmation
-- SMS, sent today unconditionally and platform-wide by
-- app/api/fulfillment/process-order/route.ts. Default true so every
-- existing shop's behavior is unchanged until an owner explicitly turns
-- it off from the new Shop Overview page.
ALTER TABLE public.shop_settings
  ADD COLUMN IF NOT EXISTS order_confirmation_sms_enabled BOOLEAN NOT NULL DEFAULT true;
