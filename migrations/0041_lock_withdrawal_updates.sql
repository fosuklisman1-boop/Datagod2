-- Prevent users from modifying withdrawal account details or amount after submission,
-- and lock down the overly permissive admin UPDATE policy.
--
-- Attack vectors fixed:
-- 1. "Users can update their pending withdrawals" allowed changing account_details,
--    amount, withdrawal_method — a hacker could redirect a payout to their own account.
-- 2. "Admins can update withdrawal requests" used USING(true)/WITH CHECK(true) —
--    any authenticated user could update any withdrawal record directly via SDK.
--
-- Fix: Users can only cancel (set status = 'cancelled') their own pending withdrawals.
--      All other updates go through the service role key (backend API) which bypasses RLS.

-- Drop existing overly permissive policies
DROP POLICY IF EXISTS "Users can update their pending withdrawals" ON public.withdrawal_requests;
DROP POLICY IF EXISTS "Admins can update withdrawal requests" ON public.withdrawal_requests;

-- Users may only cancel their own pending withdrawals (status change only).
-- They cannot change account_details, amount, or withdrawal_method.
CREATE POLICY "Users can cancel own pending withdrawals"
  ON public.withdrawal_requests FOR UPDATE
  USING (
    user_id = auth.uid()
    AND status = 'pending'
  )
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'cancelled'
    -- Ensure financial fields are unchanged (cannot redirect payout)
    AND amount = (SELECT amount FROM public.withdrawal_requests WHERE id = withdrawal_requests.id)
    AND account_details = (SELECT account_details FROM public.withdrawal_requests WHERE id = withdrawal_requests.id)
    AND withdrawal_method = (SELECT withdrawal_method FROM public.withdrawal_requests WHERE id = withdrawal_requests.id)
  );

-- All admin updates (approve/reject) go through the service role key which bypasses
-- RLS entirely — no permissive authenticated-user policy needed.
