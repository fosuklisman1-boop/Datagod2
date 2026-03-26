-- PROFIT-TO-WALLET DEBT RECOVERY SCRIPT
-- Purpose: Automatically clear negative wallet balances using available shop profits.

-- STEP 1: Schema Adjustments
-- Ensure we can add metadata to profits and that we can insert records not tied to a specific order.
ALTER TABLE shop_profits ALTER COLUMN shop_order_id DROP NOT NULL;
ALTER TABLE shop_profits ADD COLUMN IF NOT EXISTS description TEXT;

-- STEP 2: Recovery Logic (Execute in SQL Editor)
DO $$
DECLARE
    r RECORD;
    v_recoverable numeric;
BEGIN
    FOR r IN 
        SELECT 
            w.user_id,
            u.email,
            w.balance as wallet_balance,
            us.id as shop_id
        FROM wallets w
        JOIN users u ON w.user_id = u.id
        JOIN user_shops us ON w.user_id = us.user_id
        WHERE w.balance < 0
    LOOP
        -- Calculate available profit for this shop (pending or credited)
        SELECT COALESCE(SUM(profit_amount), 0) INTO v_recoverable
        FROM shop_profits 
        WHERE shop_id = r.shop_id AND status IN ('pending', 'credited');

        -- Recovery amount is the minimum of (debt) and (available profit)
        v_recoverable := LEAST(ABS(r.wallet_balance), v_recoverable);
        
        IF v_recoverable > 0 THEN
            RAISE NOTICE 'Recovering GHS % from shop profit for user % (%)', v_recoverable, r.user_id, r.email;
            
            -- I. Insert negative profit record (status 'credited' means it affects available balance immediately)
            -- We use a unique reference in the description to prevent double-counting if run twice
            INSERT INTO shop_profits (shop_id, profit_amount, status, description, created_at)
            VALUES (r.shop_id, -v_recoverable, 'credited', 'One-time Wallet Debt Recovery (System Adjustment)', NOW());
            
            -- II. Update Wallet (Credit the debt)
            UPDATE wallets 
            SET balance = balance + v_recoverable,
                total_credited = COALESCE(total_credited, 0) + v_recoverable,
                updated_at = NOW()
            WHERE user_id = r.user_id;
            
            -- III. Record transaction for user audit
            INSERT INTO transactions (user_id, type, amount, source, description, balance_before, balance_after, status, created_at)
            VALUES (
                r.user_id, 
                'credit', 
                v_recoverable, 
                'debt_recovery', 
                'System balance synchronization (adjustment)', 
                r.wallet_balance, 
                r.wallet_balance + v_recoverable, 
                'completed', 
                NOW()
            );
        END IF;
    END LOOP;

    -- STEP 3: Sync Shop Available Balance Cache
    -- This ensures the dashboard reflects the new balance after recovery.
    UPDATE shop_available_balance sab
    SET 
        available_balance = (
            SELECT COALESCE(SUM(profit_amount), 0)
            FROM shop_profits sp
            WHERE sp.shop_id = sab.shop_id AND sp.status = 'credited'
        ) - (
            SELECT COALESCE(SUM(amount), 0)
            FROM withdrawal_requests wr
            WHERE wr.shop_id = sab.shop_id AND wr.status = 'approved'
        ),
        updated_at = NOW();
END $$;
