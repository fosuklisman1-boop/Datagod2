-- 0126_delivery_channel_standard_bundles.sql
-- Live delivery estimate: add the Standard Bundles channel (hubtel_data_orders) to the admin
-- "mark as delayed" overrides. Safe to re-run.

ALTER TABLE public.delivery_channel_overrides DROP CONSTRAINT IF EXISTS delivery_channel_overrides_channel_check;
ALTER TABLE public.delivery_channel_overrides
  ADD CONSTRAINT delivery_channel_overrides_channel_check
  CHECK (channel IN ('mtn','telecel','at_ishare','at_bigtime','utility','standard'));
