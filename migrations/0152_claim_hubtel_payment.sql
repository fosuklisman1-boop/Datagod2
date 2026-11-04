-- 0152_claim_hubtel_payment.sql
--
-- Hubtel collection core (payment gateway plan 3, task 4). ADDITIVE. Idempotent (re-runnable). Requires 0151.
--
--   claim_hubtel_payment(p_reference)  the exactly-once claim used by lib/hubtel-pay/confirm.ts before it calls
--     the shared charge handler. ONE conditional UPDATE: pending -> confirming, or a confirming claim older than
--     10 minutes (a caller that died mid-handler) -> re-claimed. Returns the claimed row, or no row when another
--     caller holds it / it is final / it does not exist. Only the caller that gets a row back may continue.
--
--   Why an RPC rather than a supabase-js .update().or(): the staleness cut-off uses the DATABASE clock (now()),
--   not each Vercel instance's clock, and the predicate lives in one reviewed place. Under READ COMMITTED a second
--   concurrent UPDATE waits on the row lock, then re-checks the WHERE against the committed row and matches
--   nothing, so two simultaneous callers (callback + sweep) can never both win.
--
--   claim_count  number of successful claims. confirm.ts sends a row to needs_review instead of calling the handler
--     again once the winning claim's count reaches 3 (caps the loop from a handler that always throws or a final
--     write that keeps failing). Added here, not in 0151, so 0151 stays as reviewed.
--
-- Security: SECURITY DEFINER with a pinned search_path; EXECUTE revoked from PUBLIC/anon/authenticated and
-- granted to service_role only.

ALTER TABLE public.hubtel_payments
  ADD COLUMN IF NOT EXISTS claim_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.claim_hubtel_payment(p_reference text)
RETURNS SETOF public.hubtel_payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN QUERY
  UPDATE public.hubtel_payments
     SET status = 'confirming',
         claimed_at = now(),
         claim_count = claim_count + 1,
         updated_at = now()
   WHERE reference = p_reference
     AND (status = 'pending'
          OR (status = 'confirming' AND claimed_at < now() - interval '10 minutes'))
  RETURNING *;
END
$fn$;

REVOKE ALL ON FUNCTION public.claim_hubtel_payment(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_hubtel_payment(text) TO service_role;
