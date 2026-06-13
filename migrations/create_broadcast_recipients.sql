-- Broadcast recipients queue.
--
-- Previously a broadcast was driven entirely by a client-side loop: the admin's
-- browser POSTed batches of 2 users at a time, and only on the final iteration
-- did it call `finalize`. Closing the tab killed the loop, so the remaining
-- recipients were NEVER attempted (no log row at all) and the broadcast stuck
-- at status='processing' forever.
--
-- This table persists every recipient up front so a server-side cron can drain
-- the queue regardless of whether the admin's tab is open. Each row carries its
-- own attempt counter so retries always terminate (see claim function).

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id UUID NOT NULL REFERENCES broadcast_logs(id) ON DELETE CASCADE,
  user_id UUID,                 -- nullable: not every recipient is a registered user
  email TEXT,
  phone TEXT,
  name TEXT,
  -- overall row lifecycle: pending -> claimed -> sent | failed
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- per-channel outcome, e.g. {"email":"sent","sms":"failed","push":"skipped"}
  channel_status JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drain queries filter by (broadcast_id, status); the partial index keeps the
-- hot "what's left to send" lookup tiny even when sent rows pile up.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_drain
  ON broadcast_recipients(broadcast_id, created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on broadcast_recipients" ON broadcast_recipients;
CREATE POLICY "Service role full access on broadcast_recipients"
  ON broadcast_recipients FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Admins read-only (history/progress views go through the service-role API, but
-- this keeps direct reads possible for debugging).
DROP POLICY IF EXISTS "Admins read broadcast_recipients" ON broadcast_recipients;
CREATE POLICY "Admins read broadcast_recipients"
  ON broadcast_recipients FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin')
  );

-- ---------------------------------------------------------------------------
-- claim_broadcast_recipients: atomically grab the next batch to send.
--
-- Picks rows that still need work (pending, or failed but under the attempt
-- cap), flips them to 'claimed', and bumps their attempt counter — all in one
-- statement under FOR UPDATE SKIP LOCKED so concurrent drains (cron + the
-- init-triggered first drain) never grab the same row. Returns the claimed
-- rows so the worker knows exactly what to process.
--
-- max_attempts is the hard stop that makes retry terminate: once a row's
-- attempts reach it, the row is no longer eligible and is treated as terminally
-- failed until an admin explicitly resets it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_broadcast_recipients(bid UUID, lim INT, max_attempts INT DEFAULT 3)
RETURNS SETOF broadcast_recipients
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE broadcast_recipients br
  SET status = 'claimed',
      attempts = br.attempts + 1,
      claimed_at = now()
  WHERE br.id IN (
    SELECT id FROM broadcast_recipients
    WHERE broadcast_id = bid
      AND (status = 'pending' OR (status = 'failed' AND attempts < max_attempts))
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT lim
  )
  RETURNING br.*;
END;
$$;

-- ---------------------------------------------------------------------------
-- recompute_broadcast_results: rebuild broadcast_logs.results from the queue
-- and flip the broadcast to 'completed' once nothing is left to do.
--
-- This is the single source of truth for the stats shown in the UI. A broadcast
-- is 'completed' only when there are no pending/claimed rows AND no failed rows
-- still under the attempt cap — i.e. the system has done everything it can.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_broadcast_results(bid UUID, max_attempts INT DEFAULT 3)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  res JSONB;
  outstanding INT;
BEGIN
  SELECT jsonb_build_object(
    'total', count(*),
    'email', jsonb_build_object(
      'sent',    count(*) FILTER (WHERE channel_status->>'email' = 'sent'),
      'failed',  count(*) FILTER (WHERE channel_status->>'email' = 'failed'),
      'pending', count(*) FILTER (WHERE email IS NOT NULL AND (channel_status->>'email') IS NULL AND status IN ('pending','claimed'))
    ),
    'sms', jsonb_build_object(
      'sent',    count(*) FILTER (WHERE channel_status->>'sms' = 'sent'),
      'failed',  count(*) FILTER (WHERE channel_status->>'sms' = 'failed'),
      'pending', count(*) FILTER (WHERE phone IS NOT NULL AND (channel_status->>'sms') IS NULL AND status IN ('pending','claimed'))
    ),
    'push', jsonb_build_object(
      'sent',    count(*) FILTER (WHERE channel_status->>'push' = 'sent'),
      'failed',  count(*) FILTER (WHERE channel_status->>'push' = 'failed')
    ),
    'whatsapp', jsonb_build_object(
      'sent',    count(*) FILTER (WHERE channel_status->>'whatsapp' = 'sent'),
      'failed',  count(*) FILTER (WHERE channel_status->>'whatsapp' = 'failed')
    )
  )
  INTO res
  FROM broadcast_recipients
  WHERE broadcast_id = bid;

  SELECT count(*)
  INTO outstanding
  FROM broadcast_recipients
  WHERE broadcast_id = bid
    AND (status IN ('pending','claimed') OR (status = 'failed' AND attempts < max_attempts));

  UPDATE broadcast_logs
  SET results = res,
      status = CASE WHEN outstanding = 0 THEN 'completed' ELSE 'processing' END
  WHERE id = bid;
END;
$$;
