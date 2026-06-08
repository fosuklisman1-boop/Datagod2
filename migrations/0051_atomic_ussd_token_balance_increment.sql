-- Atomic token balance increment for USSD shop codes.
-- Replaces the read-then-write pattern in the Paystack webhook handler which
-- could lose a credit if two webhook calls arrived concurrently for the same
-- shop_code_id (Paystack retries the webhook on network errors).
CREATE OR REPLACE FUNCTION increment_ussd_token_balance(
  p_shop_code_id uuid,
  p_amount integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE ussd_shop_codes
  SET token_balance = token_balance + p_amount,
      updated_at    = now()
  WHERE id = p_shop_code_id;
$$;
