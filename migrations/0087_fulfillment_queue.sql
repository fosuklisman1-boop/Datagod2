-- fulfillment_queue: durable queue for bulk MTN order fulfillment.
-- Rows are enqueued by the admin UI and drained by the cron every minute,
-- so the browser tab can close without killing the job.
CREATE TABLE IF NOT EXISTS fulfillment_queue (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       UUID        NOT NULL,
  order_id       TEXT        NOT NULL,
  order_type     TEXT        NOT NULL CHECK (order_type IN ('shop','bulk','api','ussd','ussd_shop')),
  provider       TEXT,
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','processing','completed','failed')),
  attempt_count  INT         NOT NULL DEFAULT 0,
  error_message  TEXT,
  enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempted_at TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fq_pending
  ON fulfillment_queue(enqueued_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_fq_batch
  ON fulfillment_queue(batch_id, status);

-- Atomically claims up to p_limit pending rows for processing.
-- Uses FOR UPDATE SKIP LOCKED so concurrent cron invocations never
-- double-claim the same row.
CREATE OR REPLACE FUNCTION claim_fulfillment_queue(p_limit INT DEFAULT 20)
RETURNS SETOF fulfillment_queue
LANGUAGE sql
AS $$
  UPDATE fulfillment_queue
  SET
    status            = 'processing',
    attempt_count     = attempt_count + 1,
    last_attempted_at = NOW()
  WHERE id IN (
    SELECT id
    FROM   fulfillment_queue
    WHERE  status = 'pending'
    ORDER  BY enqueued_at ASC
    LIMIT  p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

-- Service-role-only: queue is admin-internal.
ALTER TABLE fulfillment_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY fq_service_only ON fulfillment_queue
  USING (false);
