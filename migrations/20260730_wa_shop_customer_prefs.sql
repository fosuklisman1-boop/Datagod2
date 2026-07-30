-- migrations/20260730_wa_shop_customer_prefs.sql
-- Remembers each WhatsApp customer's last-used shop code so returning
-- customers on the shop bot skip re-entering their shop code.
CREATE TABLE IF NOT EXISTS public.wa_shop_customer_prefs (
  phone TEXT PRIMARY KEY,
  shop_code_id UUID NOT NULL REFERENCES public.ussd_shop_codes(id) ON DELETE CASCADE,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_shop_customer_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON public.wa_shop_customer_prefs;
CREATE POLICY "Service role only" ON public.wa_shop_customer_prefs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
