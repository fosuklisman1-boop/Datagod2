-- migrations/0071_broadcast_recipient_rendered_message.sql
-- Bulk SMS Milestone 5: per-recipient personalised broadcast bodies.
--
-- Group broadcasts can carry merge fields ([FirstName]/[LastName]/[Phone]). Each
-- recipient therefore needs its OWN rendered message rather than the single
-- broadcast_logs.message shared by role/specific sends.
--
-- This is purely additive and backwards-compatible:
--   * The column is nullable; existing rows + role/specific broadcasts leave it
--     NULL and the drain falls back to broadcast_logs.message (rendered_message
--     ?? message) — byte-identical to today's behaviour.
--   * claim_broadcast_recipients RETURNS SETOF broadcast_recipients (RETURNING
--     br.*), so the new column is surfaced to the drain with NO function change.
--   * recompute_broadcast_results never references message columns — unaffected.

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS rendered_message TEXT;
