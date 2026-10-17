-- 0125_delivery_channel_overrides.sql
-- Live delivery estimate (lib/delivery-estimate): an admin can mark a channel down. While down, the
-- dashboard shows the numbers frozen at that moment (frozen), 0% strength and no cheerful headline, and
-- purchase confirmation screens show nothing. One row per channel; no row = not overridden.
-- Server-only (service role): RLS on, no policies, no anon/authenticated access.

CREATE TABLE IF NOT EXISTS public.delivery_channel_overrides (
  channel          text PRIMARY KEY CHECK (channel IN ('mtn','telecel','at_ishare','at_bigtime','utility')),
  is_manually_down boolean NOT NULL DEFAULT false,
  reason           text CHECK (reason IS NULL OR length(reason) <= 200),
  since            timestamptz,
  frozen           jsonb,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.delivery_channel_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_channel_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.delivery_channel_overrides TO service_role;
