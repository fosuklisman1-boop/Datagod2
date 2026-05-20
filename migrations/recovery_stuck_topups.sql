-- RECOVERY SCRIPT FOR STUCK TOP-UPS
-- This script identifies wallet payments that were completed but not credited 
-- because the user_id was missing during initialization.

DO $$
DECLARE
    r RECORD;
    v_user_id UUID;
    v_credit_amt DECIMAL;
    v_res JSON;
BEGIN
    FOR r IN 
        SELECT 
            wp.id as payment_id,
            wp.reference,
            wp.amount as total_amt,
            wp.fee,
            pa.email
        FROM wallet_payments wp
        JOIN payment_attempts pa ON wp.reference = pa.reference
        WHERE wp.status = 'completed' 
          AND wp.user_id IS NULL 
          AND wp.order_id IS NULL -- Only Top-ups
    LOOP
        -- Find the user by email
        SELECT id INTO v_user_id FROM users WHERE email = r.email OR phone_number = r.email LIMIT 1;
        
        IF v_user_id IS NOT NULL THEN
            v_credit_amt := r.total_amt - r.fee;
            
            RAISE NOTICE 'Recovering payment % for user % (Amt: %)', r.reference, r.email, v_credit_amt;
            
            -- Call the credit function
            SELECT credit_wallet_safely(
                v_user_id, 
                v_credit_amt, 
                r.reference, 
                'Recovered wallet top-up', 
                'wallet_topup'
            ) INTO v_res;
            
            -- Update the payment record with the correctly link user_id
            UPDATE wallet_payments SET user_id = v_user_id WHERE id = r.payment_id;
            
            RAISE NOTICE 'Result: %', v_res;
        ELSE
            RAISE WARNING 'Could not find user for email % (Ref: %)', r.email, r.reference;
        END IF;
    END LOOP;
END;
$$;
