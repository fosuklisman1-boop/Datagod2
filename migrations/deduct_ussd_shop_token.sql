-- Atomic USSD shop token deduction
-- Returns TRUE if a token was successfully deducted, FALSE if:
--   - the shop code has no tokens left (token_balance = 0)
--   - the shop code is not active
-- Uses a conditional UPDATE so concurrent callers can't race past zero.

CREATE OR REPLACE FUNCTION deduct_ussd_shop_token(p_shop_code_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rows_affected INTEGER;
BEGIN
  UPDATE ussd_shop_codes
  SET    token_balance = token_balance - 1,
         updated_at    = NOW()
  WHERE  id             = p_shop_code_id
    AND  token_balance  > 0
    AND  status         = 'active';

  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  RETURN rows_affected > 0;
END;
$$;
