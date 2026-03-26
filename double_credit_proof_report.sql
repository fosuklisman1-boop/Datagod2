-- ULTIMATE PROOF & DEBT REPORT (POST-DELETION)
-- Purpose: Find evidence of double-credits AND show what each user currently owes.

WITH payment_records AS (
    -- Paystack says they paid this:
    SELECT 
        user_id,
        reference as paystack_ref,
        count(*) as status_count,
        sum(amount) as theoretical_credit,
        min(amount) as actual_paid
    FROM wallet_payments
    WHERE status = 'completed'
    GROUP BY user_id, reference
),
ledger_records AS (
    -- Database ledger shows this (after your deletion):
    SELECT 
        user_id,
        reference_id as paystack_ref,
        count(*) as txn_count,
        sum(amount) as confirmed_credit
    FROM transactions
    WHERE type = 'credit' AND reference_id IS NOT NULL
    GROUP BY user_id, reference_id
),
audit_reconciliation AS (
    -- Compare them to find the "hidden" correction:
    SELECT 
        u.email,
        w.user_id,
        pr.paystack_ref as "Paystack Reference",
        pr.actual_paid as "Single Payment (GHS)",
        pr.theoretical_credit as "What They Got Originally (GHS)",
        lr.confirmed_credit as "What Ledger Shows Now (GHS)",
        w.balance as "Current Wallet Balance",
        (pr.theoretical_credit - lr.confirmed_credit) as "Discrepancy (Double Credit Amount)"
    FROM payment_records pr
    JOIN users u ON pr.user_id = u.id
    JOIN wallets w ON u.id = w.user_id
    LEFT JOIN ledger_records lr ON pr.paystack_ref = lr.paystack_ref
)
SELECT 
    email as "User Email",
    "Paystack Reference",
    "Single Payment (GHS)",
    "What They Got Originally (GHS)",
    "What Ledger Shows Now (GHS)",
    "Current Wallet Balance" as "Amount Owed (if negative)",
    CASE 
        WHEN "Current Wallet Balance" < 0 THEN ABS("Current Wallet Balance")
        ELSE 0
    END as "Strict Debt Amount"
FROM audit_reconciliation
-- Only show users whoever had a discrepancy or are in debt
WHERE "Discrepancy (Double Credit Amount)" > 0 OR "Current Wallet Balance" < 0
ORDER BY "Current Wallet Balance" ASC;

-- HOW TO USE:
-- 1. Run this script in the Supabase SQL Editor.
-- 2. "Amount Owed (if negative)" shows their current wallet status.
-- 3. "What They Got Originally" vs "What Ledger Shows Now" proves that the 
--    extra money was removed because it was a duplicate.
