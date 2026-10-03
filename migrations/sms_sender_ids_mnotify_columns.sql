-- Parallel mNotify columns on sms_sender_ids, alongside the existing Moolre
-- ones. A new row starts untouched on both providers (local_status and
-- mnotify_local_status both default 'pending', both *_pushed_at null) — no
-- provider is contacted until an admin explicitly pushes.
ALTER TABLE sms_sender_ids
  ADD COLUMN IF NOT EXISTS mnotify_status text,
  ADD COLUMN IF NOT EXISTS mnotify_local_status text NOT NULL DEFAULT 'pending'
    CHECK (mnotify_local_status IN ('pending', 'active', 'rejected')),
  ADD COLUMN IF NOT EXISTS mnotify_last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS mnotify_pushed_at timestamptz,
  ADD COLUMN IF NOT EXISTS moolre_pushed_at timestamptz;
