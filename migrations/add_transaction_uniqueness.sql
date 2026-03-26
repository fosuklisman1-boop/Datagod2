-- 1. Remove any existing duplicates if they exist (keep the oldest one)
DELETE FROM transactions a USING (
      SELECT MIN(ctid) as keep_ctid, user_id, reference_id, type
      FROM transactions
      WHERE reference_id IS NOT NULL AND type = 'credit'
      GROUP BY user_id, reference_id, type
      HAVING COUNT(*) > 1
) b
WHERE a.user_id = b.user_id 
  AND a.reference_id = b.reference_id 
  AND a.type = b.type
  AND a.ctid > b.keep_ctid;

-- 2. Add uniqueness constraint
ALTER TABLE transactions 
ADD CONSTRAINT unique_transaction_reference 
UNIQUE (user_id, reference_id, type);
