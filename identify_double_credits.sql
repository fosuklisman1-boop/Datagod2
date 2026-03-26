-- Query to get full details of duplicate credit transactions
-- This identifies references with multiple credits and lists each individual record

WITH duplicate_references AS (
    SELECT 
        reference_id,
        user_id
    FROM 
        transactions
    WHERE 
        type = 'credit' 
        AND reference_id IS NOT NULL
    GROUP BY 
        reference_id, user_id
    HAVING 
        COUNT(*) > 1
)
SELECT 
    t.id as transaction_id,
    t.reference_id,
    u.email,
    u.id as user_id,
    t.amount,
    t.balance_before,
    t.balance_after,
    t.created_at,
    t.source,
    t.description
FROM 
    transactions t
JOIN 
    users u ON t.user_id = u.id
JOIN 
    duplicate_references dr ON t.reference_id = dr.reference_id AND t.user_id = dr.user_id
WHERE 
    t.type = 'credit'
ORDER BY 
    t.reference_id, t.created_at ASC;
