-- 0127_saved_bill_accounts.sql
-- "Saved meters": a user's saved ECG meters / Ghana Water / TV / broadband accounts for one-tap repeat
-- payments (lib/bills/saved.ts). Only details the user typed; every payment still verifies with Hubtel.
-- Server-only (service role, via /api/bills/saved with the user's bearer token): RLS on, no policies.

CREATE TABLE IF NOT EXISTS public.saved_bill_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  biller            text NOT NULL CHECK (biller IN ('ecg','ghana_water','dstv','gotv','startimes','telecel_broadband')),
  nickname          text CHECK (nickname IS NULL OR length(nickname) <= 40),
  account           text NOT NULL CHECK (length(account) BETWEEN 4 AND 40),
  phone             text,
  email             text,
  broadband_account text NOT NULL DEFAULT '',
  meter_type        text CHECK (meter_type IS NULL OR meter_type IN ('prepaid','postpaid')),
  customer_name     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, biller, account, broadband_account)
);

CREATE INDEX IF NOT EXISTS saved_bill_accounts_user_idx ON public.saved_bill_accounts (user_id, created_at DESC);

ALTER TABLE public.saved_bill_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.saved_bill_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_bill_accounts TO service_role;
