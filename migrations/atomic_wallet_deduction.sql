-- Atomic wallet deduction to prevent double-spend race conditions
-- When two requests race, only one can succeed — the second will get no rows back
-- and the application treats that as "Insufficient balance"

CREATE OR REPLACE FUNCTION deduct_wallet(
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS TABLE(new_balance NUMERIC, old_balance NUMERIC, new_total_spent NUMERIC)
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE wallets
  SET balance = balance - p_amount,
      total_spent = COALESCE(total_spent, 0) + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id
    AND balance >= p_amount
  RETURNING 
    balance AS new_balance,
    (balance + p_amount) AS old_balance,
    total_spent AS new_total_spent;
$$;
