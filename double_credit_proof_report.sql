-- PROOF OF DOUBLE CREDIT REPORT
-- Purpose: Generate a list of users who received multiple credits for the same Paystack reference.
-- Use this to explain balance adjustments to customers.

WITH duplicate_sets AS (
    -- Identify groups of transactions with the same user and reference
    SELECT 
        user_id,
        reference_id,
        count(*) as credit_count,
        min(created_at) as first_credit_at,
        max(created_at) as last_credit_at,
        sum(amount) as total_amount_credited,
        min(amount) as actual_paid_amount
    FROM transactions
    WHERE type = 'credit' AND reference_id IS NOT NULL
    GROUP BY user_id, reference_id
    HAVING count(*) > 1
),
detailed_proof AS (
    -- Link the sets back to the users and actual transaction IDs
    SELECT 
        u.email,
        ds.reference_id as "Paystack Reference",
        ds.credit_count as "Times Credited",
        ds.actual_paid_amount as "Amount Actually Paid (GHS)",
        ds.total_amount_credited as "Total Amount Credited (GHS)",
        (ds.total_amount_credited - ds.actual_paid_amount) as "Extra Amount Received (GHS)",
        ds.first_credit_at as "First Credit Received",
        ds.last_credit_at as "Duplicate Credit Received",
        (
            SELECT string_agg(id::text, ', ')
            FROM transactions t2
            WHERE t2.user_id = ds.user_id 
              AND t2.reference_id = ds.reference_id
              AND t2.type = 'credit'
        ) as "Transaction UUIDs involved"
    FROM duplicate_sets ds
    JOIN users u ON ds.user_id = u.id
)
SELECT * FROM detailed_proof
ORDER BY "Duplicate Credit Received" DESC;

-- HOW TO USE THIS:
-- 1. Run this in the Supabase SQL Editor.
-- 2. Export the results as CSV or Screenshot.
-- 3. If a customer (e.g., test@example.com) asks why their balance was adjusted:
--    - Find their email in this report.
--    - Show them the "First Credit" and "Duplicate Credit" timestamps.
--    - Point out the "Paystack Reference" which is unique to their payment.
