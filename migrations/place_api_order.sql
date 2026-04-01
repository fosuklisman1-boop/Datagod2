-- Atomic function to place an API order
-- Handles balance check, wallet deduction, transaction logging, and order insertion in one transaction.

CREATE OR REPLACE FUNCTION place_api_order(
  p_user_id UUID,
  p_api_key_id UUID,
  p_package_id UUID,
  p_network TEXT,
  p_volume_gb NUMERIC,
  p_price NUMERIC,
  p_recipient_phone TEXT,
  p_api_reference TEXT,
  p_description TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_old_balance NUMERIC;
  v_new_balance NUMERIC;
  v_order_id UUID;
  v_result JSONB;
BEGIN
  -- 1. Get and lock the wallet row to prevent concurrent updates
  SELECT balance INTO v_old_balance
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_old_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Wallet not found');
  END IF;

  -- 2. Check sufficient balance
  IF v_old_balance < p_price THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient balance', 'balance', v_old_balance, 'required', p_price);
  END IF;

  -- 3. Calculate new balance
  v_new_balance := v_old_balance - p_price;

  -- 4. Deduct wallet
  UPDATE wallets
  SET balance = v_new_balance,
      total_spent = COALESCE(total_spent, 0) + p_price,
      updated_at = now()
  WHERE user_id = p_user_id;

  -- 5. Create the API order
  INSERT INTO api_orders (
    user_id,
    api_key_id,
    package_id,
    network,
    volume_gb,
    price,
    recipient_phone,
    api_reference,
    status,
    created_at,
    updated_at
  )
  VALUES (
    p_user_id,
    p_api_key_id,
    p_package_id,
    p_network,
    p_volume_gb,
    p_price,
    p_recipient_phone,
    p_api_reference,
    'pending',
    now(),
    now()
  )
  RETURNING id INTO v_order_id;

  -- 6. Create transaction record
  INSERT INTO transactions (
    user_id,
    type,
    source,
    amount,
    balance_before,
    balance_after,
    description,
    reference_id,
    status,
    created_at
  )
  VALUES (
    p_user_id,
    'debit',
    'api_order',
    p_price,
    v_old_balance,
    v_new_balance,
    p_description,
    v_order_id,
    'completed',
    now()
  );

  -- 7. Return success result
  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'new_balance', v_new_balance,
    'old_balance', v_old_balance
  );

EXCEPTION
  WHEN unique_violation THEN
    -- Handle duplicate api_reference
    RETURN jsonb_build_object('success', false, 'error', 'Duplicate reference', 'code', '23505');
  WHEN OTHERS THEN
    -- Rollback is automatic in plpgsql on exception
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
