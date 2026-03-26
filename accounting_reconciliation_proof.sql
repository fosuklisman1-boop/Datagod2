-- ULTIMATE RECONCILIATION AUDIT (V5)
-- This version includes ALL transaction types (Admin Credits, Refunds, etc.)

WITH deduplicated_credits AS (
    -- We take only ONE credit per reference_id to ignore double-credits from bugs
    -- We include 'credit', 'admin_credit', and 'refund' as money entering the wallet
    SELECT DISTINCT ON (user_id, COALESCE(reference_id, id::text))
        user_id,
        amount,
        type,
        reference_id,
        created_at
    FROM transactions 
    WHERE type IN ('credit', 'admin_credit', 'refund') 
      AND status = 'completed'
    ORDER BY user_id, COALESCE(reference_id, id::text), created_at ASC
),
total_in AS (
    SELECT 
        user_id,
        SUM(amount) as total_real_money_in
    FROM deduplicated_credits
    GROUP BY user_id
),
total_out AS (
    SELECT 
        user_id,
        SUM(amount) as total_spent
    FROM transactions 
    -- We include 'debit' and 'admin_debit' as money leaving the wallet
    WHERE type IN ('debit', 'admin_debit') 
      AND status = 'completed'
    GROUP BY user_id
),
final_audit AS (
    SELECT 
        u.email,
        w.user_id,
        COALESCE(ti.total_real_money_in, 0) as ideal_money_in,
        COALESCE(to_out.total_spent, 0) as ideal_money_out,
        (COALESCE(ti.total_real_money_in, 0) - COALESCE(to_out.total_spent, 0)) as ideal_balance,
        w.balance as actual_db_balance
    FROM wallets w
    JOIN users u ON w.user_id = u.id
    LEFT JOIN total_in ti ON w.user_id = ti.user_id
    LEFT JOIN total_out to_out ON w.user_id = to_out.user_id
)
SELECT 
    email as "User Email",
    ROUND(ideal_money_in::numeric, 2) as "Ideal Total In (No Doubles)",
    ROUND(ideal_money_out::numeric, 2) as "Total Spent (Debits)",
    ROUND(ideal_balance::numeric, 2) as "Ideal Balance (Target)",
    ROUND(actual_db_balance::numeric, 2) as "Real DB Balance",
    ROUND((actual_db_balance - ideal_balance)::numeric, 2) as "HIDDEN DOUBLE CREDITS (GHS)"
FROM final_audit
WHERE ABS(actual_db_balance - ideal_balance) > 0.01
   OR actual_db_balance < -0.01
ORDER BY ABS(actual_db_balance - ideal_balance) DESC;
