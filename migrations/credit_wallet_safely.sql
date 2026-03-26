-- Atomic wallet credit to prevent double-crediting race conditions
-- This function handles check-and-credit-and-log in a single transaction

CREATE OR REPLACE FUNCTION credit_wallet_safely(
  p_user_id UUID,
  p_amount NUMERIC,
  p_reference_id TEXT,
  p_description TEXT,
  p_source TEXT
)
RETURNS TABLE(new_balance NUMERIC, old_balance NUMERIC, transaction_id UUID, already_processed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old_balance NUMERIC;
  v_new_balance NUMERIC;
  v_tx_id UUID;
BEGIN
  -- 1. Check for existing transaction (Idempotency)
  SELECT id INTO v_tx_id
  FROM transactions
  WHERE reference_id = p_reference_id
    AND user_id = p_user_id
    AND type = 'credit'
  LIMIT 1;

  IF v_tx_id IS NOT NULL THEN
    -- Already credited, return current state without changes
    SELECT balance INTO v_old_balance FROM wallets WHERE user_id = p_user_id;
    RETURN QUERY SELECT v_old_balance, v_old_balance, v_tx_id, TRUE;
    RETURN;
  END IF;

  -- 2. Get old balance and lock the wallet row for update to prevent concurrent updates
  SELECT balance INTO v_old_balance
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_old_balance IS NULL THEN
    -- Wallet might not exist for this user? Check and create or error. 
    -- Assuming wallets are created on user signup.
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  -- 3. Update wallet
  UPDATE wallets
  SET balance = balance + p_amount,
      total_credited = COALESCE(total_credited, 0) + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING balance INTO v_new_balance;

  -- 4. Create transaction record
  INSERT INTO transactions (
    user_id,
    amount,
    type,
    status,
    description,
    reference_id,
    source,
    balance_before,
    balance_after,
    created_at
  ) VALUES (
    p_user_id,
    p_amount,
    'credit',
    'completed',
    p_description,
    p_reference_id,
    p_source,
    v_old_balance,
    v_new_balance,
    now()
  )
  RETURNING id INTO v_tx_id;

  RETURN QUERY SELECT v_new_balance, v_old_balance, v_tx_id, FALSE;
END;
$$;
