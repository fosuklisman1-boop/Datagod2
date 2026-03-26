-- Wallet Correction SQL (Dry Run & Execution)
-- This script identifies double credits and calculates the necessary deduction.

-- STEP 1: Dry Run - See who will be affected and who will go negative
WITH duplicate_info AS (
    SELECT 
        t.user_id,
        u.email,
        t.reference_id,
        COUNT(*) - 1 as extra_credits_count,
        SUM(t.amount) - MIN(t.amount) as amount_to_deduct
    FROM 
        transactions t
    JOIN 
        users u ON t.user_id = u.id
    WHERE 
        t.type = 'credit' AND t.reference_id IS NOT NULL
    GROUP BY 
        t.user_id, u.email, t.reference_id
    HAVING 
        COUNT(*) > 1
)
SELECT 
    di.email,
    di.reference_id,
    di.amount_to_deduct,
    w.balance as current_balance,
    (w.balance - di.amount_to_deduct) as projected_balance,
    CASE 
        WHEN (w.balance - di.amount_to_deduct) < 0 THEN 'WILL GO NEGATIVE'
        ELSE 'OK'
    END as status
FROM 
    duplicate_info di
JOIN 
    wallets w ON di.user_id = w.user_id;


-- STEP 2: Execution
-- This will deduct the extra amounts and clean up the redundant records
DO $$
DECLARE
    r RECORD;
    v_old_balance NUMERIC;
    v_new_balance NUMERIC;
BEGIN
    FOR r IN 
        WITH duplicate_ids AS (
            SELECT id, 
                   ROW_NUMBER() OVER (PARTITION BY user_id, reference_id, type ORDER BY created_at ASC) as rn,
                   user_id,
                   amount,
                   reference_id
            FROM transactions
            WHERE type = 'credit' AND reference_id IS NOT NULL
        )
        SELECT * FROM duplicate_ids WHERE rn > 1
    LOOP
        -- 1. Get current balance and lock row
        SELECT balance INTO v_old_balance FROM wallets WHERE user_id = r.user_id FOR UPDATE;
        v_new_balance := v_old_balance - r.amount;

        -- 2. Update wallet
        UPDATE wallets 
        SET balance = v_new_balance,
            total_credited = GREATEST(0, total_credited - r.amount), -- Adjust total credited, don't go below 0
            updated_at = now()
        WHERE user_id = r.user_id;

        -- 3. Delete the duplicate transaction record
        DELETE FROM transactions WHERE id = r.id;

        -- 4. Log to console
        RAISE NOTICE 'Corrected user % for reference %: Deducted % (New balance: %)', r.user_id, r.reference_id, r.amount, v_new_balance;
    END LOOP;
END $$;
