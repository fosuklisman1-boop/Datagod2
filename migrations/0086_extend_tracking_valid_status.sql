-- Extend mtn_fulfillment_tracking valid_status constraint to include
-- 'reversed' (admin-flagged provider reversal) and 'abandoned' (row
-- superseded by a newer fulfillment attempt or admin manual download).
ALTER TABLE mtn_fulfillment_tracking DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE mtn_fulfillment_tracking
  ADD CONSTRAINT valid_status CHECK (
    status = ANY (ARRAY[
      'pending', 'processing', 'completed', 'failed',
      'error', 'retrying', 'reversed', 'abandoned'
    ])
  );

-- Sync any tracking rows that were already reversed at the order level
-- but whose tracking status was never updated (flagReversal DB write was
-- blocked by the missing constraint value).
UPDATE mtn_fulfillment_tracking t
SET status = 'reversed', updated_at = now()
FROM shop_orders s
WHERE t.shop_order_id = s.id
  AND t.provider = 'xpress'
  AND t.status = 'completed'
  AND s.order_status = 'reversed';
