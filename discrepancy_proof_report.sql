-- DISCREPANCY PROOF REPORT
-- Purpose: Identify users whose wallet balance is inconsistent with their transaction history.
-- This mismatch serves as proof that double-credits occurred and were then cleaned up by the migration script.

WITH transaction_sums AS (
    SELECT 
        user_id,
        SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END) as total_credits,
        SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END) as total_debits,
        COUNT(*) as transaction_count
    FROM transactions
    WHERE status = 'completed'
    GROUP BY user_id
),
wallet_reconciliation AS (
    SELECT 
        u.email,
        w.user_id,
        w.balance as current_balance,
        (ts.total_credits - ts.total_debits) as ledger_balance,
        (w.balance - (ts.total_credits - ts.total_debits)) as discrepancy_amount,
        ts.transaction_count
    FROM wallets w
    JOIN users u ON w.user_id = u.id
    LEFT JOIN transaction_sums ts ON w.user_id = ts.user_id
)
SELECT 
    email,
    current_balance,
    ledger_balance,
    discrepancy_amount as "Missing Credit Proof",
    CASE 
        WHEN discrepancy_amount > 0 THEN 'Mismatch: More money than records (Double Credit Proof)'
        WHEN discrepancy_amount < 0 THEN 'Mismatch: Less money than records (Possible error)'
        ELSE 'Balanced'
    END as status
FROM wallet_reconciliation
WHERE ABS(discrepancy_amount) > 0.01
ORDER BY discrepancy_amount DESC;

-- HOW TO USE THIS:
-- 1. Run this in the Supabase SQL Editor.
-- 2. Any user with a positive "Missing Credit Proof" had more money in their wallet 
--    than their transaction history can account for.
-- 3. This discrepancy is the exact amount of the double-credit(s) that were 
--    deleted from the 'transactions' table to prevent further errors.
