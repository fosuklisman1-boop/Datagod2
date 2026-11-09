-- 0148_storefront_subagent_join.sql
--
-- Written as 0146 and APPLIED to production as 0146 on 2026-11-03; renumbered to 0148 when main took 0146 and 0147.
-- Code comments that say "migration 0146" about join columns mean this file.
--
-- Storefront visitors can sign up as sub-agents under a shop (spec: docs/superpowers/specs/ storefront sub-agent
-- instant join). ADDITIVE. Idempotent (re-runnable).
--
--   user_shops.joined_via              NULL, or 'storefront' when the sub-agent signed up through a storefront
--   user_shops.prices_set_at           when the sub-agent first set their own prices
--   user_shops.dealer_rates_enabled    default true: existing sub-agents change in no way, so no backfill
--   user_shops.sub_agent_setup_alert_at  when the "set your prices" reminder was last sent
--   user_shops.sub_agent_prices_ready_notified_at  when waiting joiners were last told the owner's prices are set
--   (the trigger also protects those two, plus is_blocked, block_reason, parent_shop_id and tier_level)
--   sub_agent_join_intents             pending sign-up intent keyed by auth user; service_role only
--   app_settings.sub_agent_open_join_enabled   singleton row (key IS NULL); default false (ships dark)
--   trigger user_shops_protect_join_columns    a signed-in owner cannot edit is_active, joined_via,
--       prices_set_at or dealer_rates_enabled on their own shop (RLS lets owners update their own row).
--       Service-role routes, migrations and the SQL editor (auth.role() not authenticated/anon) are unaffected.

ALTER TABLE public.user_shops
  ADD COLUMN IF NOT EXISTS joined_via text,
  ADD COLUMN IF NOT EXISTS prices_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS dealer_rates_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sub_agent_setup_alert_at timestamptz,
  ADD COLUMN IF NOT EXISTS sub_agent_prices_ready_notified_at timestamptz;

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_shops'::regclass AND conname = 'user_shops_joined_via_check'
  ) THEN
    ALTER TABLE public.user_shops
      ADD CONSTRAINT user_shops_joined_via_check CHECK (joined_via = 'storefront');
  END IF;
END
$mig$;

CREATE TABLE IF NOT EXISTS public.sub_agent_join_intents (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_shop_id uuid NOT NULL REFERENCES public.user_shops(id) ON DELETE CASCADE,
  shop_name      text NOT NULL,
  first_name     text,
  last_name      text,
  phone          text NOT NULL,
  -- SHA-256 (hex) of the random nonce carried by this join's confirmation link; the raw nonce is never stored.
  nonce_hash     text NOT NULL,
  -- The phone_otp_verifications row that proved the phone; one proof backs at most one intent.
  otp_verification_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  consumed_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_agent_join_intents_otp
  ON public.sub_agent_join_intents (otp_verification_id)
  WHERE otp_verification_id IS NOT NULL;

ALTER TABLE public.sub_agent_join_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sub_agent_join_intents FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_sub_agent_join_intents_parent
  ON public.sub_agent_join_intents (parent_shop_id);

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS sub_agent_open_join_enabled boolean NOT NULL DEFAULT false;

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
  ) THEN
    RAISE EXCEPTION 'protected shop columns cannot be changed by the shop owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS user_shops_protect_join_columns ON public.user_shops;
CREATE TRIGGER user_shops_protect_join_columns
  BEFORE UPDATE ON public.user_shops
  FOR EACH ROW EXECUTE FUNCTION public.user_shops_protect_join_columns();

-- Verify after apply:
--   SELECT count(*) FROM public.user_shops WHERE dealer_rates_enabled IS NOT TRUE;   -- 0
--   SELECT sub_agent_open_join_enabled FROM public.app_settings WHERE key IS NULL;   -- false
--   SELECT has_table_privilege('authenticated', 'public.sub_agent_join_intents', 'SELECT');  -- false
