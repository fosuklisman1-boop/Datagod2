-- 0150_kuntanii_provider.sql
--
-- Kuntanii (11th fulfillment provider, MTN-only). ADDITIVE. Idempotent (re-runnable).
--
--   mtn_fulfillment_tracking.provider_cost_ghs   what the provider charged us for the order (GHS). Generic name so
--       other providers can fill it later; Kuntanii only for now. NULL when unknown.
--   mtn_fulfillment_tracking.provider_reference  the provider's own reference for the order. NULL when none.
--   kuntanii_not_received_reports   "data not received" disputes raised from the admin UI. At most one open or
--       escalated report per tracking row (partial unique index kuntanii_nr_one_open_per_tracking): it is the claim
--       gate that stops a double-click or overlapping run raising the same dispute twice.
--   kuntanii_unknown_attempts       order attempts whose outcome was unknown (timeout) and must be re-checked.
--       order_id is text (internal order ids are uuid or text depending on the order table); order_type nullable.
--
-- Security: RLS enabled on both new tables with NO policies, and all privileges revoked from anon/authenticated.
-- Only server routes using the service role touch them.

ALTER TABLE public.mtn_fulfillment_tracking
  ADD COLUMN IF NOT EXISTS provider_cost_ghs numeric(12,2) NULL,
  ADD COLUMN IF NOT EXISTS provider_reference text NULL;

CREATE TABLE IF NOT EXISTS public.kuntanii_not_received_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id       uuid NOT NULL REFERENCES public.mtn_fulfillment_tracking(id),
  external_order_id text NOT NULL,
  order_reference   text,
  report_reference  text NOT NULL UNIQUE,
  phone_number      text,
  data_gb           numeric,
  reason_code       text,
  description       text,
  dispute_status    text NOT NULL DEFAULT 'open'
                    CHECK (dispute_status IN ('open', 'escalated', 'resolved', 'rejected')),
  raised_by         uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_checked_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS kuntanii_nr_one_open_per_tracking
  ON public.kuntanii_not_received_reports (tracking_id)
  WHERE dispute_status IN ('open', 'escalated');

CREATE TABLE IF NOT EXISTS public.kuntanii_unknown_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_order_id text NOT NULL UNIQUE,
  order_id          text,
  order_type        text NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  last_status       text
);

ALTER TABLE public.kuntanii_not_received_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kuntanii_unknown_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.kuntanii_not_received_reports FROM anon, authenticated;
REVOKE ALL ON public.kuntanii_unknown_attempts FROM anon, authenticated;
