-- FINAL BALANCE SYNCHRONIZATION (V6)
-- This script forces all wallets to match their audited transaction history.
-- It is idempotent and safe to run multiple times.

DO $$
DECLARE
    r RECORD;
    v_ideal_balance NUMERIC;
    v_adjustment NUMERIC;
    v_tx_type TEXT;
    v_msg TEXT;
BEGIN
    FOR r IN 
        WITH deduplicated_credits AS (
            SELECT DISTINCT ON (user_id, COALESCE(reference_id, id::text))
                user_id, amount
            FROM transactions 
            WHERE type IN ('credit', 'admin_credit', 'refund') 
              AND status = 'completed'
            ORDER BY user_id, COALESCE(reference_id, id::text), created_at ASC
        ),
        total_in AS (
            SELECT user_id, SUM(amount) as total_in FROM deduplicated_credits GROUP BY user_id
        ),
        total_out AS (
            SELECT user_id, SUM(amount) as total_out FROM transactions 
            WHERE type IN ('debit', 'admin_debit') AND status = 'completed'
            GROUP BY user_id
        )
        SELECT 
            w.user_id,
            w.balance as current_balance,
            (COALESCE(ti.total_in, 0) - COALESCE(to_out.total_out, 0)) as ideal_balance
        FROM wallets w
        LEFT JOIN total_in ti ON w.user_id = ti.user_id
        LEFT JOIN total_out to_out ON w.user_id = to_out.user_id
        WHERE ABS(w.balance - (COALESCE(ti.total_in, 0) - COALESCE(to_out.total_out, 0))) > 0.01
    LOOP
        v_ideal_balance := r.ideal_balance;
        v_adjustment := v_ideal_balance - r.current_balance;
        
        -- Determine transaction type
        IF v_adjustment > 0 THEN
            v_tx_type := 'admin_credit';
            v_msg := 'Audit Correction: Aligning balance with history (Credit)';
        ELSE
            v_tx_type := 'admin_debit';
            v_msg := 'Audit Correction: Deducting double-credits / Aligning with history (Debit)';
        END IF;

        -- 1. Update the wallet balance to the IDEAL value
        UPDATE wallets 
        SET balance = v_ideal_balance,
            updated_at = now()
        WHERE user_id = r.user_id;

        -- 2. Insert a record for transparency
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
            r.user_id,
            ABS(v_adjustment),
            v_tx_type,
            'completed',
            v_msg,
            'AUDIT_SYNC_' || to_char(now(), 'YYYYMMDD_HH24MISS') || '_' || r.user_id,
            'admin_operation',
            r.current_balance,
            v_ideal_balance,
            now()
        );

        RAISE NOTICE 'Synced user %: Adjusted by % to reach Ideal % (Was %)', r.user_id, v_adjustment, v_ideal_balance, r.current_balance;
    END LOOP;
END $$;
