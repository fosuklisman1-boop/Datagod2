-- 0110_hubtel_callback_logs_status_check.sql
-- Adds a third log direction, 'status_check': every transaction-status lookup (us -> relay -> Hubtel)
-- is logged with Hubtel's full response so it can be viewed and copied on /admin/ussd-hubtel.
--
-- ADDITIVE and safe to apply before or after the deploy: until it is applied, status-check log
-- inserts are rejected by the old CHECK and dropped (logged as a console error, never thrown), and
-- the payment flow itself is unaffected. Same lockdown and 30-day retention as 0109.

ALTER TABLE hubtel_callback_logs DROP CONSTRAINT IF EXISTS hubtel_callback_logs_direction_check;
ALTER TABLE hubtel_callback_logs
  ADD CONSTRAINT hubtel_callback_logs_direction_check
  CHECK (direction IN ('inbound_fulfillment', 'outbound_callback', 'status_check'));
